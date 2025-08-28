/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { css, html, LitElement, svg } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';

import { throttle } from '../utils/throttle';

import './PromptController';
import './PlayPauseButton';
import type { PlaybackState, Prompt } from '../types';
import { MidiDispatcher } from '../utils/MidiDispatcher';

/** The grid of prompt inputs. */
@customElement('prompt-dj-midi')
export class PromptDjMidi extends LitElement {
  // FIX: This member cannot have an 'override' modifier because its containing class 'PromptDjMidi' does not extend another class.
  // FIX: Removed 'override' modifier for compatibility.
  static styles = css`
    :host {
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      box-sizing: border-box;
      position: relative;
      overflow-y: auto;
    }
    #background {
      will-change: background-image;
      position: absolute;
      height: 100%;
      width: 100%;
      z-index: -1;
      background: #111;
    }
    #grid {
      width: 80vmin;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 2.5vmin;
      margin-top: 8vmin;
    }
    prompt-controller {
      width: 100%;
    }
    play-pause-button {
      position: relative;
      width: 15vmin;
      flex-shrink: 0;
      margin-top: 2vmin;
      margin-bottom: 4vmin;
    }
    #buttons {
      position: absolute;
      top: 0;
      left: 0;
      padding: 5px;
      display: flex;
      gap: 5px;
    }
    button {
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      color: #fff;
      background: #0002;
      -webkit-font-smoothing: antialiased;
      border: 1.5px solid #fff;
      border-radius: 4px;
      user-select: none;
      padding: 3px 6px;
      &.active, &.recording {
        background-color: #fff;
        color: #000;
      }
      &.recording {
        background-color: #c70039;
        border-color: #c70039;
        color: #fff;
      }
    }
    select {
      font: inherit;
      padding: 5px;
      background: #fff;
      color: #000;
      border-radius: 4px;
      border: none;
      outline: none;
      cursor: pointer;
    }
    #progress-container {
      width: 25vmin;
      height: 3vmin;
      display: flex;
      align-items: center;
      gap: 1.5vmin;
      margin-top: 4vmin;
    }
    #progress-bar-track {
      flex-grow: 1;
      height: 0.8vmin;
      background-color: #0005;
      border-radius: 0.4vmin;
      overflow: hidden;
      border: 0.1vmin solid #fff3;
    }
    #progress-bar {
      width: 100%;
      height: 100%;
      background-color: #fff;
      transform-origin: left;
      transition: transform 100ms linear;
    }
    #freeze-button {
      width: 3vmin;
      height: 3vmin;
      background: none;
      border: none;
      padding: 0;
      cursor: pointer;
      opacity: 0.5;
      transition: opacity 0.2s;
      flex-shrink: 0;
    }
    #freeze-button > svg {
      width: 100%;
      height: 100%;
      fill: #fff;
    }
    #freeze-button:hover {
      opacity: 1;
    }
    #freeze-button.active {
      opacity: 1;
    }
  `;

  private prompts: Map<string, Prompt>;
  private midiDispatcher: MidiDispatcher;

  @property({ type: Boolean }) private showMidi = false;
  @property({ type: String }) public playbackState: PlaybackState = 'stopped';
  @property({ type: Boolean }) public isRecording = false;
  @property({ type: Number }) public phraseProgress = 0;
  @property({ type: Boolean }) public isFrozen = false;

  @state() public audioLevel = 0;
  @state() private midiInputIds: string[] = [];
  @state() private activeMidiInputId: string | null = null;
  
  @query('#import-input') private importInput!: HTMLInputElement;

  @property({ type: Object })
  private filteredPrompts = new Set<string>();

  constructor(
    initialPrompts: Map<string, Prompt>,
  ) {
    super();
    this.prompts = initialPrompts;
    this.midiDispatcher = new MidiDispatcher();
  }

  private handlePromptChanged(e: CustomEvent<Prompt>) {
    const { promptId, text, weight, cc } = e.detail;
    const prompt = this.prompts.get(promptId);

    if (!prompt) {
      console.error('prompt not found', promptId);
      return;
    }

    prompt.text = text;
    prompt.weight = weight;
    prompt.cc = cc;

    const newPrompts = new Map(this.prompts);
    newPrompts.set(promptId, prompt);

    this.prompts = newPrompts;
    // FIX: Property 'requestUpdate' does not exist on type 'PromptDjMidi'.
    // FIX: Cast to LitElement to fix incorrect type error.
    (this as LitElement).requestUpdate();

    // FIX: Property 'dispatchEvent' does not exist on type 'PromptDjMidi'.
    // FIX: Cast to HTMLElement to fix incorrect type error.
    (this as HTMLElement).dispatchEvent(
      new CustomEvent('prompts-changed', { detail: this.prompts }),
    );
  }

  /** Generates radial gradients for each prompt based on weight and color. */
  private readonly makeBackground = throttle(
    () => {
      const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

      const MAX_WEIGHT = 0.5;
      const MAX_ALPHA = 0.6;

      const bg: string[] = [];

      [...this.prompts.values()].forEach((p, i) => {
        const alphaPct = clamp01(p.weight / MAX_WEIGHT) * MAX_ALPHA;
        const alpha = Math.round(alphaPct * 0xff)
          .toString(16)
          .padStart(2, '0');

        const stop = p.weight / 2;
        const x = (i % 4) / 3;
        const y = Math.floor(i / 4) / 3;
        const s = `radial-gradient(circle at ${x * 100}% ${y * 100}%, ${p.color}${alpha} 0px, ${p.color}00 ${stop * 100}%)`;

        bg.push(s);
      });

      return bg.join(', ');
    },
    30, // don't re-render more than once every XXms
  );

  private toggleShowMidi() {
    return this.setShowMidi(!this.showMidi);
  }

  public async setShowMidi(show: boolean) {
    this.showMidi = show;
    if (!this.showMidi) return;
    try {
      const inputIds = await this.midiDispatcher.getMidiAccess();
      this.midiInputIds = inputIds;
      this.activeMidiInputId = this.midiDispatcher.activeMidiInputId;
    } catch (e: any) {
      this.showMidi = false;
      // FIX: Property 'dispatchEvent' does not exist on type 'PromptDjMidi'.
      // FIX: Cast to HTMLElement to fix incorrect type error.
      (this as HTMLElement).dispatchEvent(new CustomEvent('error', {detail: e.message}));
    }
  }

  private handleMidiInputChange(event: Event) {
    const selectElement = event.target as HTMLSelectElement;
    const newMidiId = selectElement.value;
    this.activeMidiInputId = newMidiId;
    this.midiDispatcher.activeMidiInputId = newMidiId;
  }

  private playPause() {
    // FIX: Property 'dispatchEvent' does not exist on type 'PromptDjMidi'.
    // FIX: Cast to HTMLElement to fix incorrect type error.
    (this as HTMLElement).dispatchEvent(new CustomEvent('play-pause'));
  }

  public addFilteredPrompt(prompt: string) {
    this.filteredPrompts = new Set([...this.filteredPrompts, prompt]);
  }

  private handleExportClick() {
    const data = JSON.stringify(Array.from(this.prompts.entries()), null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'prompt-dj-settings.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  private handleImportClick() {
    this.importInput.click();
  }

  private handleFileImport(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const file = input.files[0];
    const reader = new FileReader();

    reader.onload = (event) => {
      try {
        const content = event.target?.result as string;
        if (!content) throw new Error('File is empty.');
        
        const parsedPrompts = JSON.parse(content);
        if (!Array.isArray(parsedPrompts)) {
          throw new Error('Invalid format: should be an array of prompts.');
        }

        const newPrompts = new Map<string, Prompt>(parsedPrompts);
        this.prompts = newPrompts;
        this.requestUpdate();
        (this as HTMLElement).dispatchEvent(
          new CustomEvent('prompts-changed', { detail: this.prompts }),
        );
      } catch (error: any) {
        (this as HTMLElement).dispatchEvent(new CustomEvent('error', { detail: `Failed to import settings: ${error.message}`}));
      } finally {
        input.value = '';
      }
    };
    reader.onerror = () => {
      (this as HTMLElement).dispatchEvent(new CustomEvent('error', { detail: 'Failed to read the file.'}));
      input.value = '';
    };

    reader.readAsText(file);
  }

  private handleRecordClick() {
    (this as HTMLElement).dispatchEvent(new CustomEvent('record-toggle'));
  }

  private handleFreezeClick() {
    (this as HTMLElement).dispatchEvent(new CustomEvent('freeze-toggle'));
  }

  private renderFreezeIcon() {
    return svg`<svg viewBox="0 0 24 24"><path d="M12,8.4c-0.4,0-0.8,0.2-1.1,0.5l-1.9,1.9c-0.3,0.3-0.5,0.7-0.5,1.1s0.2,0.8,0.5,1.1l1.9,1.9c0.3,0.3,0.7,0.5,1.1,0.5s0.8-0.2,1.1-0.5l1.9-1.9c0.3-0.3,0.5-0.7,0.5-1.1s-0.2-0.8-0.5-1.1l-1.9-1.9C12.8,8.6,12.4,8.4,12,8.4z M19.4,11.2L17,8.8c-0.6-0.6-1.3-1-2.2-1.1V4.8c0-0.7-0.6-1.3-1.3-1.3h-2.9c-0.7,0-1.3,0.6-1.3,1.3v2.9c-0.8,0.2-1.6,0.5-2.2,1.1l-2.4,2.4c-1.6,1.6-1.6,4.1,0,5.7l2.4,2.4c0.6,0.6,1.3,1,2.2,1.1v2.9c0,0.7,0.6,1.3,1.3,1.3h2.9c0.7,0,1.3-0.6,1.3-1.3v-2.9c0.8-0.2,1.6-0.5,2.2-1.1l2.4-2.4C21,15.3,21,12.8,19.4,11.2z M18,15.5l-2.4,2.4c-0.4,0.4-0.8,0.7-1.3,0.9v3.4h-2.9v-3.4c-0.5-0.2-1-0.5-1.3-0.9L7.6,15.5c-0.8-0.8-0.8-2.1,0-2.9L10,10.2c0.4-0.4,0.8-0.7,1.3-0.9V5.8h2.9v3.4c0.5,0.2,1,0.5,1.3,0.9l2.4,2.4C18.8,13.4,18.8,14.7,18,15.5z"></path></svg>`;
  }

  // FIX: This member cannot have an 'override' modifier because its containing class 'PromptDjMidi' does not extend another class.
  // FIX: Removed 'override' modifier for compatibility.
  render() {
    const bg = styleMap({
      backgroundImage: this.makeBackground(),
    });
    return html`<div id="background" style=${bg}></div>
      <div id="buttons">
        <button
          @click=${this.toggleShowMidi}
          class=${this.showMidi ? 'active' : ''}
          >MIDI</button
        >
        <select
          @change=${this.handleMidiInputChange}
          .value=${this.activeMidiInputId || ''}
          style=${this.showMidi ? '' : 'visibility: hidden'}>
          ${this.midiInputIds.length > 0
        ? this.midiInputIds.map(
          (id) =>
            html`<option value=${id}>
                    ${this.midiDispatcher.getDeviceName(id)}
                  </option>`,
        )
        : html`<option value="">No devices found</option>`}
        </select>
        <button @click=${this.handleExportClick}>Export</button>
        <button @click=${this.handleImportClick}>Import</button>
        <input type="file" id="import-input" @change=${this.handleFileImport} style="display:none" accept=".json" />
        <button @click=${this.handleRecordClick} class=${this.isRecording ? 'recording' : ''}>
          ${this.isRecording ? 'Stop' : 'Record'}
        </button>
      </div>
      <div id="grid">${this.renderPrompts()}</div>
      <div id="progress-container">
        <div id="progress-bar-track">
            <div id="progress-bar" style=${styleMap({ transform: `scaleX(${this.phraseProgress})` })}></div>
        </div>
        <button id="freeze-button" class=${this.isFrozen ? 'active' : ''} @click=${this.handleFreezeClick} title="Freeze melody">
            ${this.renderFreezeIcon()}
        </button>
      </div>
      <play-pause-button .playbackState=${this.playbackState} @click=${this.playPause}></play-pause-button>`;
  }

  private renderPrompts() {
    return [...this.prompts.values()].map((prompt) => {
      return html`<prompt-controller
        promptId=${prompt.promptId}
        ?filtered=${this.filteredPrompts.has(prompt.text)}
        cc=${prompt.cc}
        text=${prompt.text}
        weight=${prompt.weight}
        color=${prompt.color}
        .midiDispatcher=${this.midiDispatcher}
        .showCC=${this.showMidi}
        audioLevel=${this.audioLevel}
        @prompt-changed=${this.handlePromptChanged}>
      </prompt-controller>`;
    });
  }
}