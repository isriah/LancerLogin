// Rebuild the committed fixed synthetic image constants after running fixtures.py.
import {readFile,writeFile} from 'node:fs/promises';
const images={};for(const ext of ['png','jpeg']) images[ext]=(await readFile(new URL(`output/geometry.${ext}`,import.meta.url))).toString('base64');
await writeFile(new URL('synthetic-images.json',import.meta.url),JSON.stringify(images));
