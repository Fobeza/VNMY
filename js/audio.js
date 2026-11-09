/* Optional story audio. Older packages need no changes. */
import { resolveUrl } from './format.js';

export const AUDIO_DEFAULTS = { masterVolume: .8, musicVolume: .6, soundVolume: .7, voiceVolume: .9, backgroundAudio: false };
export function audioVolume(settings, channel) {
  const bounded = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
  return bounded(settings.masterVolume, .8) * bounded(settings[`${channel}Volume`], AUDIO_DEFAULTS[`${channel}Volume`] ?? 1);
}

export class StoryAudio {
  constructor(story, settings = {}, create = () => document.createElement('audio')) {
    this.story = story; this.settings = { ...AUDIO_DEFAULTS, ...settings }; this.create = create;
    this.channels = new Map(); this.hidden = false; this.paused = false; this.suspended = false; this.destroyed = false; this.context = null;
  }
  // GainNode also controls volume where a mobile media element ignores .volume.
  // https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/createMediaElementSource
  connect(audio) {
    const Context = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!Context) return {};
    try {
      this.context ||= new Context();
      const source = this.context.createMediaElementSource(audio), gain = this.context.createGain();
      source.connect(gain); gain.connect(this.context.destination);
      return { source, gain };
    } catch { return {}; }
  }
  setVolume(entry, channel) {
    const volume = audioVolume(this.settings, channel);
    if (entry.gain) { entry.audio.volume = 1; entry.gain.gain.value = volume; }
    else entry.audio.volume = volume;
  }
  allowed(channel) { return !this.destroyed && !(this.hidden && !this.settings.backgroundAudio) && !(this.paused && channel !== 'music') && !(this.suspended && channel === 'music'); }
  play(channel, path, { loop = false, restart = false } = {}) {
    if (this.destroyed) return Promise.resolve(false);
    const src = resolveUrl(this.story, path);
    if (!src) { this.stop(channel); return Promise.resolve(false); }
    let entry = this.channels.get(channel);
    if (!entry || entry.src !== src || restart) {
      this.stop(channel);
      const audio = this.create(); if (/^https?:/i.test(src)) audio.crossOrigin = 'anonymous'; audio.src = src; audio.loop = loop; audio.preload = 'auto';
      entry = { audio, src, ...this.connect(audio) }; this.channels.set(channel, entry);
    }
    this.setVolume(entry, channel);
    if (!this.allowed(channel)) return Promise.resolve(false);
    if (!entry.audio.paused) return Promise.resolve(true);
    return Promise.all([entry.audio.play(), this.context?.resume()]).then(() => true, () => false);
  }
  render(visual, step, replay = false) {
    this.play('music', visual.music || '', { loop: true });
    if (!replay) {
      this.play('voice', step.voice || '', { restart: true });
      this.play('sound', step.sound || '', { restart: true });
    }
  }
  sync() {
    if ([...this.channels.keys()].some(channel => this.allowed(channel))) this.context?.resume().catch(() => {});
    for (const [channel, entry] of this.channels) {
      this.setVolume(entry, channel);
      if (!this.allowed(channel)) entry.audio.pause();
      else if (entry.audio.paused && !entry.audio.ended) Promise.resolve(entry.audio.play()).catch(() => {});
    }
  }
  applySettings(settings) { this.settings = { ...this.settings, ...settings }; this.sync(); }
  setPaused(value) { this.paused = value; this.sync(); }
  setHidden(value) { this.hidden = value; this.sync(); }
  suspendMusic(value) { this.suspended = value; this.sync(); }
  stop(channel) { const entry = this.channels.get(channel); if (entry) { entry.audio.pause(); entry.audio.removeAttribute('src'); entry.source?.disconnect(); entry.gain?.disconnect(); entry.audio.load?.(); this.channels.delete(channel); } }
  destroy() { this.destroyed = true; for (const key of [...this.channels.keys()]) this.stop(key); if (this.context && this.context.state !== 'closed') this.context.close().catch(() => {}); }
}

export async function playTestTone(settings) {
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) return false;
  const context = new Context();
  try {
    await context.resume();
    const tone = context.createOscillator(), gain = context.createGain();
    tone.type = 'sine'; tone.frequency.value = 440;
    const volume = audioVolume(settings, 'sound') * .15;
    gain.gain.setValueAtTime(volume, context.currentTime);
    if (volume > 0) gain.gain.exponentialRampToValueAtTime(.0001, context.currentTime + .3);
    tone.connect(gain); gain.connect(context.destination); tone.start(); tone.stop(context.currentTime + .32);
    await new Promise(resolve => tone.addEventListener('ended', resolve, { once: true }));
    return true;
  } finally { await context.close(); }
}
