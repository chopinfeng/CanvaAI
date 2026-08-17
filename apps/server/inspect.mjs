import { readFileSync } from 'node:fs';
import * as Y from 'yjs';
const doc = new Y.Doc();
Y.applyUpdate(doc, new Uint8Array(readFileSync(process.argv[2])));
console.log('shape 数量:', doc.getMap('shapes').size);
doc.getMap('shapes').forEach((m) => console.log(' -', m.get('type'), 'layer=' + m.get('layer'), 'role=' + (m.get('meta')?.role ?? '-'), 'x=' + m.get('x'), 'y=' + m.get('y')));
