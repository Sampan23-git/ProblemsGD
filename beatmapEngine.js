(function () {
  'use strict';

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  // Linear interpolation over a {times[], values[]} curve using binary search.
  function interpAt(times, values, t) {
    if (!Array.isArray(times) || !times.length) return 0;
    if (t <= times[0]) return values[0];
    const last = times.length - 1;
    if (t >= times[last]) return values[last];
    let lo = 0, hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid; else hi = mid;
    }
    const t0 = times[lo], t1 = times[hi];
    const v0 = values[lo], v1 = values[hi];
    const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    return v0 + (v1 - v0) * f;
  }

  // 0..1 "how busy/energetic" the track is at time t, from the pre-analyzed curve.
  // This is the main "rhythm" signal we use to drive difficulty.
  function getIntensityAt(beatmap, t) {
    const curve = beatmap && beatmap.intensity_curve;
    if (!curve || !Array.isArray(curve.times) || !curve.times.length) return 0.4;
    return clamp(interpAt(curve.times, curve.values, Number(t) || 0), 0, 1);
  }

  // Real (locally varying) BPM at time t, from the analyzed tempo map.
  // Exposed for completeness, but the built-in speed/chart helpers deliberately
  // do NOT use this: automatic tempo tracking can be noisy on short segments,
  // so global_bpm + intensity_curve give steadier, more predictable gameplay.
  function getBpmAt(beatmap, t) {
    const segments = Array.isArray(beatmap && beatmap.tempo_change_segments) ? beatmap.tempo_change_segments : [];
    const time = Number(t) || 0;
    for (const seg of segments) {
      const s = Number(seg && seg.start_time);
      const e = Number(seg && seg.end_time);
      if (time >= s && time <= e) {
        const bStart = Number(seg.bpm_start), bEnd = Number(seg.bpm_end);
        const f = e > s ? (time - s) / (e - s) : 0;
        return bStart + (bEnd - bStart) * f;
      }
    }
    return Number(beatmap && beatmap.global_bpm) || 120;
  }

  function isInSegmentType(beatmap, t, type) {
    const segments = Array.isArray(beatmap && beatmap.intensity_segments) ? beatmap.intensity_segments : [];
    const time = Number(t) || 0;
    return segments.some((seg) => {
      const s = Number(seg && seg.start_time != null ? seg.start_time : 0);
      const e = Number(seg && seg.end_time != null ? seg.end_time : s);
      return String(seg && seg.type || '').toLowerCase() === type && time >= s && time <= e;
    });
  }

  // Small deterministic PRNG (mulberry32) so a given song always builds the
  // same chart (no re-shuffling lanes every time you hit play).
  function makeRng(seed) {
    let s = seed >>> 0 || 1;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function pickLane(prevLane, rng, laneCount) {
    let lane = Math.floor(rng() * laneCount);
    if (lane === prevLane && rng() < 0.75) {
      lane = (lane + 1 + Math.floor(rng() * (laneCount - 1))) % laneCount;
    }
    return lane;
  }

  const DEFAULT_CHART_OPTIONS = {
    laneCount: 4,
    minGapSec: 0.16,               // never place two notes closer together than this
    lowIntensitySkipChance: 0.55,  // thin out quiet intros/outros
    breakdownSkipChance: 0.45,     // thin out tagged "breakdown" sections
    baseOnsetChance: 0.3,          // base chance an onset becomes an extra note
    buildupOnsetBoost: 0.35,       // extra chance during tagged "buildup" sections
    chordIntensityThreshold: 0.78, // above this intensity, beats can become chords
    chordChance: 0.35
  };

  // Turns the analyzed beat/onset/intensity data into an actual timed note chart.
  // This is the piece that was missing before: notes are now placed at the exact
  // timestamps the audio analysis found, instead of a generic metronome guess.
  // Returns notes sorted by time; simultaneous notes share a `groupId` (chord).
  function buildChart(beatmap, options) {
    const opts = Object.assign({}, DEFAULT_CHART_OPTIONS, options || {});
    const beatTimes = Array.isArray(beatmap && beatmap.beat_times) ? beatmap.beat_times : [];
    const onsetTimes = Array.isArray(beatmap && beatmap.onset_times) ? beatmap.onset_times : [];
    const seed = hashString(String((beatmap && beatmap.file) || 'song')) ^ beatTimes.length;
    const rng = makeRng(seed);

    const notes = [];
    let prevLane = -1;
    let lastTime = -Infinity;

    function tryAdd(time, source) {
      const t = Number(time);
      if (t - lastTime < opts.minGapSec) return null;
      const lane = pickLane(prevLane, rng, opts.laneCount);
      const note = { time: t, lane, source, hit: false, missed: false, groupId: null };
      notes.push(note);
      prevLane = lane;
      lastTime = t;
      return note;
    }

    // 1) Beats are the rhythmic backbone.
    beatTimes.forEach((time) => {
      const t = Number(time);
      const intensity = getIntensityAt(beatmap, t);
      if (isInSegmentType(beatmap, t, 'breakdown') && rng() < opts.breakdownSkipChance) return;
      if (intensity < 0.15 && rng() < opts.lowIntensitySkipChance) return;
      const note = tryAdd(t, 'beat');
      if (note && intensity > opts.chordIntensityThreshold && rng() < opts.chordChance) {
        const groupId = 'g' + t.toFixed(4);
        note.groupId = groupId;
        const secondLane = (note.lane + 1 + Math.floor(rng() * (opts.laneCount - 1))) % opts.laneCount;
        notes.push({ time: t, lane: secondLane, source: 'chord', hit: false, missed: false, groupId });
        prevLane = secondLane;
      }
    });

    // 2) Onsets add extra notes on top, weighted by intensity -> more notes
    //    (harder) during louder/busier moments, fewer during quiet ones.
    onsetTimes.forEach((time) => {
      const t = Number(time);
      const intensity = getIntensityAt(beatmap, t);
      const buildupBoost = isInSegmentType(beatmap, t, 'buildup') ? opts.buildupOnsetBoost : 0;
      const chance = opts.baseOnsetChance * (0.3 + intensity) + buildupBoost;
      if (rng() > chance) return;
      tryAdd(t, 'onset');
    });

    notes.sort((a, b) => a.time - b.time);

    // Finale flourish: the very last note becomes a full chord across all lanes.
    if (notes.length) {
      const lastNote = notes[notes.length - 1];
      if (!lastNote.groupId) {
        const groupId = 'finale';
        lastNote.groupId = groupId;
        for (let lane = 0; lane < opts.laneCount; lane++) {
          if (lane === lastNote.lane) continue;
          notes.push({ time: lastNote.time, lane, source: 'finale', hit: false, missed: false, groupId });
        }
      }
    }

    return notes.sort((a, b) => a.time - b.time);
  }

  // Effective fall speed (px/sec) at time t. Scales with the song's own global
  // tempo and, more importantly, its moment-to-moment intensity - so a chorus
  // or buildup genuinely feels faster/harder than a quiet verse.
  function getFallSpeed(beatmap, t, baseSpeedPxPerSec, options) {
    const opts = Object.assign({ intensityBoost: 0.6, minFactor: 0.75, maxFactor: 1.9 }, options || {});
    const bpm = Number(beatmap && beatmap.global_bpm) || 120;
    const bpmFactor = clamp(bpm / 120, 0.7, 1.6);
    const intensity = getIntensityAt(beatmap, t);
    const factor = clamp(bpmFactor * (1 + intensity * opts.intensityBoost), opts.minFactor, opts.maxFactor);
    return (Number(baseSpeedPxPerSec) || 430) * factor;
  }

  async function loadBeatmap(jsonPath) {
    const response = await fetch(jsonPath, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Could not load beatmap: ${jsonPath}`);
    }
    return response.json();
  }

  window.beatmapEngine = {
    clamp,
    interpAt,
    getIntensityAt,
    getBpmAt,
    isInSegmentType,
    buildChart,
    getFallSpeed,
    loadBeatmap
  };
})();
