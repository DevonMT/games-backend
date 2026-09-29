// Discover must not recommend a game you own. Run: npx tsx scripts/check-owned.ts
import { titleKey, dropOwned } from '../src/lib/claude.js';

const cases: [string, string, boolean][] = [
  ['The Witcher 3: Wild Hunt - Game of the Year Edition', 'The Witcher 3: Wild Hunt', true],
  ['Witcher 3 Wild Hunt GOTY', 'The Witcher 3: Wild Hunt', true],
  ['DOOM Eternal', 'Doom Eternal', true],
  ['Portal 2', 'Portal™ 2', true],
  ['Hades', 'Hades II', false],
  ['Hollow Knight', 'Hollow Knight: Silksong', false],
  ['Disco Elysium - The Final Cut', 'Disco Elysium', true],
  ['Okami HD', 'Ōkami HD', true],
];
let fail = 0;
for (const [a, b, same] of cases) {
  const ok = (titleKey(a) === titleKey(b)) === same;
  if (!ok) fail++;
  console.log(ok ? 'ok  ' : 'FAIL', `${same ? 'same' : 'different'}: "${a}" / "${b}"`, ok ? '' : `(${titleKey(a)} | ${titleKey(b)})`);
}
const kept = dropOwned([{ name: 'Hades II' }, { name: 'Stardew Valley' }, { name: 'Celeste' }], ['Hades', 'Stardew Valley']).map((p) => p.name);
const ok = JSON.stringify(kept) === JSON.stringify(['Hades II', 'Celeste']);
if (!ok) fail++;
console.log(ok ? 'ok  ' : 'FAIL', 'dropOwned keeps what you do not own', ok ? '' : kept);
process.exit(fail ? 1 : 0);
