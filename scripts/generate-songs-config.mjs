import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const audioDir = path.join(projectRoot, 'Музика');
const beatmapDir = path.join(projectRoot, 'БІти');
const outputDir = path.join(projectRoot, 'assets');
const outputPath = path.join(outputDir, 'songs.config.json');

function toSlug(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function safeUri(input) {
  return encodeURI(input.replace(/\\/g, '/'));
}

function normalizeTitle(fileName) {
  return fileName.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
}

function getDifficulty(bpm) {
  if (Number(bpm) >= 140) return 'Hard';
  if (Number(bpm) >= 110) return 'Normal';
  return 'Easy';
}

const pageMap = {
  'smaragd': 'Smaragd.html',
  'beta-karotin': 'beta-carotin.html',
  'linkin-park': 'linkin-park.html',
  'kulbabi': 'kulbabi.html',
  'jerk-it-out': 'JerkItOut.html',
  'starships': 'starships.html',
  'rip-city': 'ripcity.html',
  'hear-this': 'hearthis.html',
  'gubka': 'gubka.html',
  'comeback': 'comeback.html',
  'chugun': 'chugun.html',
  'bara-bara-bere-bere': 'barabere.html',
  'ez4ence': 'ez4ence.html'
};

function buildPagePath(songId) {
  return pageMap[songId] ? `./${pageMap[songId]}` : '#';
}

if (!fs.existsSync(audioDir) || !fs.existsSync(beatmapDir)) {
  console.warn('Missing source folders:');
  console.warn(' - audio:', audioDir, fs.existsSync(audioDir));
  console.warn(' - beatmaps:', beatmapDir, fs.existsSync(beatmapDir));
  process.exit(0);
}

const audioFiles = fs.readdirSync(audioDir)
  .filter((file) => /\.mp3$/i.test(file))
  .sort();

const beatmapFiles = fs.readdirSync(beatmapDir)
  .filter((file) => /\.json$/i.test(file))
  .sort();

const beatmapNames = new Set(beatmapFiles.map((file) => file.replace(/\.json$/i, '')));
const audioNames = new Set(audioFiles.map((file) => file.replace(/\.mp3$/i, '')));

for (const file of audioFiles) {
  const stem = file.replace(/\.mp3$/i, '');
  if (!beatmapNames.has(stem)) {
    console.warn(`[WARN] MP3 without matching JSON: ${file}`);
  }
}

for (const file of beatmapFiles) {
  const stem = file.replace(/\.json$/i, '');
  if (!audioNames.has(stem)) {
    console.warn(`[WARN] JSON without matching MP3: ${file}`);
  }
}

const songs = [];
for (const audioFile of audioFiles) {
  const audioStem = audioFile.replace(/\.mp3$/i, '');
  const matchingJson = beatmapFiles.find((jsonFile) => jsonFile.replace(/\.json$/i, '') === audioStem);
  if (!matchingJson) continue;

  const jsonPath = path.join(beatmapDir, matchingJson);
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const durationSec = Number(json.duration_sec ?? 0);
  const bpm = Number(json.global_bpm ?? 0);
  const beatTimes = Array.isArray(json.beat_times) ? json.beat_times : [];
  const songId = toSlug(audioStem);

  const entry = {
    id: songId || toSlug(normalizeTitle(audioFile)),
    title: normalizeTitle(audioFile),
    audioPath: safeUri(`./Музика/${audioFile}`),
    beatmapPath: safeUri(`./БІти/${matchingJson}`),
    durationSec,
    bpm,
    numBeats: beatTimes.length,
    difficulty: getDifficulty(bpm),
    pagePath: buildPagePath(songId)
  };

  songs.push(entry);
}

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: {
    audioDir: 'Музика',
    beatmapDir: 'БІти'
  },
  songs
}, null, 2));

const counts = { Easy: 0, Normal: 0, Hard: 0 };
for (const song of songs) counts[song.difficulty] += 1;

console.log(`Songs scanned: ${songs.length}`);
console.log(`Easy: ${counts.Easy} | Normal: ${counts.Normal} | Hard: ${counts.Hard}`);
console.log(`Config written to: ${outputPath}`);
