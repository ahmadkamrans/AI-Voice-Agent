require('dotenv').config();
const WebSocket = require('ws');
const { spawn, exec } = require('child_process');
const readline = require('readline');

const ws = new WebSocket('ws://localhost:3000');

ws.on('open', () => {
  console.log('Connected to server.');
  promptForRecording();
});

ws.on('message', (data) => {
  try {
    const message = JSON.parse(data);
    if (message.error) {
      console.error('Error from server:', message.error);
      promptForRecording();
      return;
    }

    const { transcription, responseText, audioPath } = message;
    console.log('Transcription:', transcription);
    console.log('AI Reply:', responseText);
    console.log('Playing response audio...');
    exec(`ffplay -nodisp -autoexit "${audioPath}"`, (err) => {
      if (err) {
        console.error('Error playing audio:', err);
      }
      promptForRecording();
    });

  } catch (err) {
    console.error('Failed to parse server message:', err);
    promptForRecording();
  }
});

ws.on('close', () => {
  console.log('Connection closed.');
});

function promptForRecording() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question('Press ENTER to record your question: ', () => {
    rl.close();
    startRecording();
  });
}

function startRecording() {
  console.log('Recording... Press ENTER to stop.');

  const ffmpeg = spawn('ffmpeg', [
    '-f', 'alsa',
    '-ac', '1',
    '-ar', '16000',
    '-i', 'default',
    '-f', 's16le',
    '-'
  ]);

  ffmpeg.stdout.on('data', (chunk) => {
    ws.send(chunk);
  });
  //hello
  ffmpeg.stderr.on('data', () => { /* silence logs */ });

  ffmpeg.on('error', (err) => {
    console.error('ffmpeg error:', err);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question('', () => {
    rl.close();
    ffmpeg.kill('SIGINT');
    ws.send('END');
    console.log('Audio streaming ended.');
  });
}
