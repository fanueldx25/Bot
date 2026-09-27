import fs from 'fs';
import path from 'path';

const FILE = path.resolve('./src/lib/data.json');
let data = {};
if (fs.existsSync(FILE)) data = JSON.parse(fs.readFileSync(FILE, 'utf8'));

const save = () => fs.writeFileSync(FILE, JSON.stringify(data, null, 2));

function pathGet(key) {
  return key.split('.').reduce((o, k) => (o ? o[k] : undefined), data);
}

export const db = {
  get: (key) => pathGet(key),
  set: (key, value) => {
    const parts = key.split('.');
    let cur = data;
    for (let i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] ??= {};
      cur = cur[parts[i]];
    }
    cur[parts.at(-1)] = value;
    save();
  },
  all: () => data,
};