// test-client.js

require('dotenv').config();
const WebSocket = require('ws');
const { spawn, exec } = require('child_process');

const ws = new WebSocket('ws://localhost:3000');

ws.on('open', () => {
  console.log('Connected to server.');
  console.log('Recording from microphone. Press ENTER to stop.');

  // Spawn ffmpeg to capture microphone audio (mono, 16kHz, raw PCM)
  const ffmpeg = spawn('ffmpeg', [
    '-f', 'alsa',
    '-ac', '1',
    '-ar', '16000',
    '-i', 'default',
    '-f', 's16le',
    '-'
  ]);

  // Send audio chunks to server
  ffmpeg.stdout.on('data', (chunk) => {
    ws.send(chunk);
  });

  ffmpeg.stderr.on('data', (data) => {
    // ffmpeg logs (ignore or uncomment to debug)
    // console.log(`ffmpeg: ${data}`);
  });

  ffmpeg.on('error', (err) => {
    console.error('ffmpeg error:', err);
  });

  // When user presses ENTER, stop recording
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', () => {
    // Stop ffmpeg process
    ffmpeg.kill('SIGINT');
    // Signal end of audio
    ws.send('END');
    console.log('Audio streaming ended.');
  });
});

ws.on('message', (data) => {
  try {
    const message = JSON.parse(data);
    if (message.error) {
      console.error('Error from server:', message.error);
      return;
    }
    const { transcription, responseText, audioPath } = message;
    console.log('Transcription:', transcription);
    console.log('AI Reply:', responseText);

    // Play audio using ffplay
    console.log('Playing response audio...');
    exec(`ffplay -nodisp -autoexit ${audioPath}`, (err) => {
      if (err) {
        console.error('Error playing audio:', err);
      }
      // Exit after playback
      process.exit(0);
    });
  } catch (err) {
    console.error('Failed to parse server message:', err);
  }
});

ws.on('close', () => {
  console.log('Connection closed.');
});
