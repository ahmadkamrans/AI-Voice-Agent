require("dotenv").config();
const WebSocket = require("ws");
const { spawn } = require("child_process");
const Speaker = require("speaker");
const Vad = require("node-vad");
const Prism = require("prism-media"); // Add at the top
const ffmpeg = require("prism-media").FFmpeg; // Use prism-media for ffmpeg

const ws = new WebSocket("ws://localhost:3000");

let isPlayingAudio = false;
let speaker = null;
let vad = new Vad(Vad.Mode.AGGRESSIVE);
let recordingProcess = null;
let isRecording = false;
let interrupted = false;
let decoder = null;
let audioReceiving = false;

// Start recording and VAD as soon as connected
ws.on("open", () => {
  console.log("Connected to server.");
  startContinuousRecording();
});

ws.on("message", (data, isBinary) => {
  if (isBinary) {
    // Only write audio to decoder if we're in the middle of audio streaming
    if (audioReceiving && decoder) {
      try {
        decoder.write(data);
      } catch (err) {
        // Handle EPIPE gracefully
        console.error("Error writing to decoder (likely closed):", err.message);
      }
    }
    return;
  }

  try {
    const message = JSON.parse(data);
    if (message.error) {
      console.error("Error from server:", message.error);
      return;
    }

    if (message.type === "transcription") {
      console.log("Transcription:", message.transcription);
      return;
    }

    if (message.type === "ai_response") {
      console.log("AI Reply:", message.responseText);
      return;
    }

    if (message.type === "audio_start") {
      isPlayingAudio = true;
      audioReceiving = true; // <-- Only allow writing audio now
      decoder = new ffmpeg({
        args: [
          '-analyzeduration', '0',
          '-loglevel', '0',
          '-f', 'mp3',
          '-ar', '22050',    // Use 22050, ElevenLabs default sample rate
          '-ac', '1',
          '-f', 's16le',
          '-',
        ]
      });
      speaker = new Speaker({
        channels: 1,
        bitDepth: 16,
        sampleRate: 22050,
        signed: true,
      });

      decoder.on('error', err => {
        console.error('Decoder error:', err.message);
      });
      speaker.on('error', err => {
        console.error('Speaker error:', err.message);
      });

      decoder.pipe(speaker);
      console.log("Playing response audio...");
      return;
    }

    if (message.type === "audio_end") {
      audioReceiving = false; // <-- Stop writing audio now
      if (decoder) {
        decoder.end();
        decoder = null;
      }
      if (speaker) {
        speaker.end();
        speaker = null;
      }
      isPlayingAudio = false;
      console.log("Bot finished speaking. Listening for user...");
      if (!isRecording) startContinuousRecording();
      return;
    }

    if (message.type === "interrupt_ack") {
      console.log("Bot response interrupted by user speech.");
      return;
    }
  } catch (err) {
    console.error("Failed to parse server message:", err);
  }
});
ws.on("close", () => {
  console.log("Connection closed.");
  if (speaker) {
    speaker.end();
    speaker = null;
  }
  stopRecording();
});

// --- Core logic for continuous VAD-based recording ---

function startContinuousRecording() {
  if (isRecording) return;
  isRecording = true;
  interrupted = false;

  console.log("Listening for user speech...");

  // sox command for 16kHz, mono, signed 16-bit little-endian PCM
  recordingProcess = spawn("sox", [
    "-q", // quiet
    "-d", // default input device
    "-r",
    "16000",
    "-c",
    "1",
    "-b",
    "16",
    "-e",
    "signed-integer",
    "-t",
    "raw",
    "-",
  ]);

  let speechBuffer = [];
  let sendingSpeech = false;
  let silenceFrames = 0;

  recordingProcess.stdout.on("data", (chunk) => {
    // VAD expects 16kHz, 16-bit, mono PCM, 320 samples (640 bytes) per frame
    for (let i = 0; i < chunk.length; i += 640) {
      const frame = chunk.slice(i, i + 640);
      if (frame.length < 640) continue;

      vad
        .processAudio(frame, 16000)
        .then((res) => {
          if (res === Vad.Event.VOICE) {
            if (!sendingSpeech) {
              console.log("Voice detected! Streaming audio to server...");
            }
            // If bot is talking, interrupt and stop playback
            if (isPlayingAudio && !interrupted) {
              interrupted = true;
              stopPlayback();
              ws.send("INTERRUPT");
              console.log("Interrupt sent to server due to user speech.");
            }
            // Start sending speech if not already
            if (!sendingSpeech) {
              sendingSpeech = true;
              speechBuffer = [];
            }
            speechBuffer.push(frame);
            ws.send(frame);
            silenceFrames = 0;
          } else if (sendingSpeech) {
            silenceFrames++;
            if (silenceFrames > 10) {
              sendingSpeech = false;
              silenceFrames = 0;
              ws.send("END");
              console.log("User stopped speaking. Audio stream ended.");
            } else {
              speechBuffer.push(frame);
              ws.send(frame);
            }
          }
        })
        .catch((err) => {
          console.error("VAD error:", err);
        });
    }
  });

  recordingProcess.stderr.on("data", (data) => {
    // Uncomment for debugging sox: console.error("sox stderr:", data.toString());
  });

  recordingProcess.on("error", (err) => {
    console.error("sox error:", err);
    stopRecording();
  });

  recordingProcess.on("close", () => {
    isRecording = false;
    console.log("Stopped listening for user speech.");
  });
}

function stopRecording() {
  if (recordingProcess) {
    recordingProcess.kill("SIGINT");
    recordingProcess = null;
    isRecording = false;
    console.log("Stopped recording process.");
  }
}

function stopPlayback() {
  if (speaker) {
    speaker.end();
    speaker = null;
  }
  isPlayingAudio = false;
  console.log("Stopped bot audio playback.");
}
