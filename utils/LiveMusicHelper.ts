/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import type { PlaybackState, Prompt } from '../types';
import type { AudioChunk, GoogleGenAI, LiveMusicFilteredPrompt, LiveMusicServerMessage, LiveMusicSession } from '@google/genai';
import { decode, decodeAudioData } from './audio';
import { throttle } from './throttle';

export class LiveMusicHelper extends EventTarget {

  private ai: GoogleGenAI;
  private model: string;

  private session: LiveMusicSession | null = null;
  private sessionPromise: Promise<LiveMusicSession> | null = null;

  private connectionError = true;

  private filteredPrompts = new Set<string>();
  private nextStartTime = 0;
  private bufferTime = 2;

  public readonly audioContext: AudioContext;
  public extraDestination: AudioNode | null = null;

  private outputNode: GainNode;
  private playbackState: PlaybackState = 'stopped';

  private prompts: Map<string, Prompt>;

  private isRecording = false;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private streamDestination: MediaStreamAudioDestinationNode;

  private isFrozen = false;
  private currentPhrase: { startTime: number; duration: number } | null = null;
  private rafId: number | null = null;

  constructor(ai: GoogleGenAI, model: string) {
    super();
    this.ai = ai;
    this.model = model;
    this.prompts = new Map();
    this.audioContext = new AudioContext({ sampleRate: 48000 });
    this.outputNode = this.audioContext.createGain();
    this.streamDestination = this.audioContext.createMediaStreamDestination();
  }

  private getSession(): Promise<LiveMusicSession> {
    if (!this.sessionPromise) this.sessionPromise = this.connect();
    return this.sessionPromise;
  }

  private async connect(): Promise<LiveMusicSession> {
    this.sessionPromise = this.ai.live.music.connect({
      model: this.model,
      callbacks: {
        onmessage: async (e: LiveMusicServerMessage) => {
          if (e.setupComplete) {
            this.connectionError = false;
          }
          // FIX: Property 'phraseMarker' does not exist on type 'LiveMusicServerMessage'. It has been renamed to 'phrase'.
          if (e.phrase) {
            const duration = e.phrase.duration;
            // A phrase marker has been received. If it has a valid duration,
            // we can update the progress bar.
            if (typeof duration === 'number' && duration > 0) {
              this.currentPhrase = {
                startTime: this.audioContext.currentTime,
                duration: duration,
              };
              // Start the requestAnimationFrame loop if it's not already running.
              if (!this.rafId) {
                this.updateProgress();
              }
            }
          }
          if (e.filteredPrompt) {
            this.filteredPrompts = new Set([...this.filteredPrompts, e.filteredPrompt.text!])
            this.dispatchEvent(new CustomEvent<LiveMusicFilteredPrompt>('filtered-prompt', { detail: e.filteredPrompt }));
          }
          if (e.serverContent?.audioChunks) {
            await this.processAudioChunks(e.serverContent.audioChunks);
          }
        },
        onerror: () => {
          this.connectionError = true;
          this.stop();
          this.dispatchEvent(new CustomEvent('error', { detail: 'Connection error, please restart audio.' }));
        },
        onclose: () => {
          this.connectionError = true;
          this.stop();
          this.dispatchEvent(new CustomEvent('error', { detail: 'Connection error, please restart audio.' }));
        },
      },
    });
    return this.sessionPromise;
  }

  private updateProgress = () => {
    if (this.rafId) cancelAnimationFrame(this.rafId);

    if (!this.currentPhrase || this.playbackState !== 'playing') {
      this.dispatchEvent(new CustomEvent('phrase-progress-changed', { detail: 0 }));
      this.rafId = null;
      return;
    }

    const elapsed = this.audioContext.currentTime - this.currentPhrase.startTime;
    const progress = Math.min(elapsed / this.currentPhrase.duration, 1);
    
    this.dispatchEvent(new CustomEvent('phrase-progress-changed', { detail: progress }));

    if (progress < 1) {
      this.rafId = requestAnimationFrame(this.updateProgress);
    } else {
        // A new phrase message from the server will restart the timer
        this.rafId = null;
    }
  }

  private setPlaybackState(state: PlaybackState) {
    this.playbackState = state;
    this.dispatchEvent(new CustomEvent('playback-state-changed', { detail: state }));
  }

  private async processAudioChunks(audioChunks: AudioChunk[]) {
    if (this.playbackState === 'paused' || this.playbackState === 'stopped') return;
    const audioBuffer = await decodeAudioData(
      decode(audioChunks[0].data!),
      this.audioContext,
      48000,
      2,
    );
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.outputNode);
    if (this.nextStartTime === 0) {
      this.nextStartTime = this.audioContext.currentTime + this.bufferTime;
      setTimeout(() => {
        this.setPlaybackState('playing');
      }, this.bufferTime * 1000);
    }
    if (this.nextStartTime < this.audioContext.currentTime) {
      this.setPlaybackState('loading');
      this.nextStartTime = 0;
      return;
    }
    source.start(this.nextStartTime);
    this.nextStartTime += audioBuffer.duration;
  }

  public get activePrompts() {
    return Array.from(this.prompts.values())
      .filter((p) => {
        return !this.filteredPrompts.has(p.text) && p.weight !== 0;
      })
  }

  public readonly setWeightedPrompts = throttle(async (prompts: Map<string, Prompt>) => {
    this.prompts = prompts;

    if (this.activePrompts.length === 0) {
      this.dispatchEvent(new CustomEvent('error', { detail: 'There needs to be one active prompt to play.' }));
      this.pause();
      return;
    }

    // store the prompts to set later if we haven't connected yet
    // there should be a user interaction before calling setWeightedPrompts
    if (!this.session) return;

    try {
      await this.session.setWeightedPrompts({
        weightedPrompts: this.activePrompts,
      });
    } catch (e: any) {
      this.dispatchEvent(new CustomEvent('error', { detail: e.message }));
      this.pause();
    }
  }, 200);

  public async play() {
    this.setPlaybackState('loading');
    this.session = await this.getSession();
    await this.setWeightedPrompts(this.prompts);
    this.audioContext.resume();
    this.session.play();
    this.outputNode.connect(this.audioContext.destination);
    if (this.extraDestination) this.outputNode.connect(this.extraDestination);
    this.outputNode.connect(this.streamDestination);
    this.outputNode.gain.setValueAtTime(0, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(1, this.audioContext.currentTime + 0.1);
  }

  public pause() {
    if (this.session) this.session.pause();
    this.setPlaybackState('paused');
    this.outputNode.gain.setValueAtTime(1, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.1);
    this.nextStartTime = 0;
    this.outputNode = this.audioContext.createGain();

    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.currentPhrase = null;
    this.dispatchEvent(new CustomEvent('phrase-progress-changed', { detail: 0 }));
  }

  public stop() {
    if (this.session) this.session.stop();
    this.setPlaybackState('stopped');
    this.outputNode.gain.setValueAtTime(0, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(1, this.audioContext.currentTime + 0.1);
    this.nextStartTime = 0;
    this.session = null;
    this.sessionPromise = null;

    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.currentPhrase = null;
    this.dispatchEvent(new CustomEvent('phrase-progress-changed', { detail: 0 }));
  }

  public async playPause() {
    switch (this.playbackState) {
      case 'playing':
        return this.pause();
      case 'paused':
      case 'stopped':
        return this.play();
      case 'loading':
        return this.stop();
    }
  }

  public async toggleFreeze() {
    if (!this.session) return;
    this.isFrozen = !this.isFrozen;
    try {
      // FIX: Property 'setFreeze' does not exist on type 'LiveMusicSession'. It has been renamed to 'setLooping'.
      await this.session.setLooping(this.isFrozen);
      this.dispatchEvent(new CustomEvent('freeze-state-changed', { detail: { isFrozen: this.isFrozen } }));
    } catch (e: any) {
      this.dispatchEvent(new CustomEvent('error', { detail: e.message }));
      this.isFrozen = !this.isFrozen; // Revert state on error
      this.dispatchEvent(new CustomEvent('freeze-state-changed', { detail: { isFrozen: this.isFrozen } }));
    }
  }

  private dispatchRecordingStateChange() {
    this.dispatchEvent(new CustomEvent('recording-state-changed', { detail: { isRecording: this.isRecording } }));
  }

  public toggleRecording() {
    if (this.isRecording) {
      this.mediaRecorder?.stop();
      this.isRecording = false;
      this.dispatchRecordingStateChange();
    } else {
      if (this.playbackState !== 'playing') {
        this.dispatchEvent(new CustomEvent('error', { detail: 'Start playback before recording.' }));
        return;
      }
      this.recordedChunks = [];
      this.mediaRecorder = new MediaRecorder(this.streamDestination.stream);
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.recordedChunks.push(event.data);
        }
      };
      this.mediaRecorder.onstop = () => {
        const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
        const blob = new Blob(this.recordedChunks, { type: mimeType });
        const url = URL.createObjectURL(blob);
        const fileExtension = mimeType.split('/')[1].split(';')[0] || 'webm';
        this.dispatchEvent(new CustomEvent('audio-exported', { detail: { url, filename: `prompt-dj-loop.${fileExtension}` } }));
        this.recordedChunks = [];
      };
      this.mediaRecorder.start();
      this.isRecording = true;
      this.dispatchRecordingStateChange();
    }
  }

}