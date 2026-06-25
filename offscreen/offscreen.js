// Offscreen recording engine. Runs in a hidden extension document (DOM context)
// so it can use getUserMedia + MediaRecorder, which the service worker cannot.
//
// One continuous MediaRecorder per session draws from a fixed-size canvas. The
// canvas is fed by whichever tab is currently active in the session, so when the
// user switches between same-domain tabs we just swap the canvas source — the
// recorder never stops, producing a single continuous video file.
//
// Hidden documents throttle requestAnimationFrame, so we drive frames manually
// with setInterval + track.requestFrame() on a captureStream(0) track.

const FPS        = 8;          // session recordings don't need high fps -> small files
const MAX_WIDTH  = 1280;       // cap resolution for size
const BITRATE    = 600_000;    // ~600 kbps VP9 -> small, legible UI capture

const sessions = new Map(); // sessionId -> session object

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.target !== 'offscreen') return;
  (async () => {
    try {
      let extra = {};
      if (msg.cmd === 'start')       await startSession(msg.sessionId, msg.streamId, msg.filename);
      else if (msg.cmd === 'switch') await switchSource(msg.sessionId, msg.streamId);
      else if (msg.cmd === 'stop')   extra = await stopSession(msg.sessionId);
      respond({ ok: true, ...extra });
    } catch (err) {
      respond({ ok: false, error: err.message });
    }
  })();
  return true;
});

async function getTabStream(streamId) {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
  });
}

function makeVideo(stream) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.srcObject = stream;
  return v;
}

function pickMimeType() {
  const prefs = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return prefs.find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';
}

async function startSession(sessionId, streamId, filename) {
  if (sessions.has(sessionId)) return; // already recording

  const stream = await getTabStream(streamId);
  const video  = makeVideo(stream);
  await video.play();
  await whenReady(video);

  // Fixed canvas size for the whole session, derived from the first source.
  const srcW = video.videoWidth  || 1280;
  const srcH = video.videoHeight || 720;
  const scale = Math.min(1, MAX_WIDTH / srcW);
  const w = Math.max(2, Math.round(srcW * scale / 2) * 2); // even dims
  const h = Math.max(2, Math.round(srcH * scale / 2) * 2);

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false });

  const captureStream = canvas.captureStream(0);
  const track = captureStream.getVideoTracks()[0];

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(captureStream, { mimeType, videoBitsPerSecond: BITRATE });
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };

  const session = { canvas, ctx, track, recorder, chunks, mimeType, filename,
                    currentVideo: video, currentStream: stream, w, h, drawTimer: null };
  sessions.set(sessionId, session);

  // Manual frame pump (hidden docs throttle rAF).
  session.drawTimer = setInterval(() => drawFrame(session), Math.round(1000 / FPS));

  recorder.start(1000); // flush a chunk each second
}

function drawFrame(session) {
  const { ctx, w, h, currentVideo, track } = session;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const vw = currentVideo.videoWidth, vh = currentVideo.videoHeight;
  if (vw && vh) {
    const s = Math.min(w / vw, h / vh);
    const dw = vw * s, dh = vh * s;
    ctx.drawImage(currentVideo, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }
  track.requestFrame();
}

async function switchSource(sessionId, streamId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const stream = await getTabStream(streamId);
  const video  = makeVideo(stream);
  await video.play();
  await whenReady(video);

  // Release the previous tab capture, then swap the draw source.
  stopStream(session.currentStream);
  session.currentVideo  = video;
  session.currentStream = stream;
}

async function stopSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return { downloaded: false };
  sessions.delete(sessionId);

  clearInterval(session.drawTimer);

  await new Promise(resolve => {
    session.recorder.onstop = resolve;
    if (session.recorder.state !== 'inactive') session.recorder.stop();
    else resolve();
  });

  stopStream(session.currentStream);
  session.track.stop();

  if (session.chunks.length === 0) return { downloaded: false }; // nothing captured

  const blob = new Blob(session.chunks, { type: session.mimeType });
  const url  = URL.createObjectURL(blob);
  await chrome.downloads.download({ url, filename: session.filename, saveAs: false });
  // Revoke once the download has had time to read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { downloaded: true, filename: session.filename, bytes: blob.size };
}

function stopStream(stream) {
  if (stream) stream.getTracks().forEach(t => t.stop());
}

// Resolve when the video has metadata (so videoWidth/Height are known). Resolves
// immediately if metadata already arrived, and has a defensive timeout so a
// missed/late event can never hang the recorder.
function whenReady(video) {
  return new Promise(resolve => {
    if (video.readyState >= 1 /* HAVE_METADATA */ && video.videoWidth) return resolve();
    video.addEventListener('loadedmetadata', () => resolve(), { once: true });
    setTimeout(resolve, 5000);
  });
}
