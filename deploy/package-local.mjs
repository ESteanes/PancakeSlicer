import { createHash } from 'node:crypto';
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [web, engine, revision, baseImage] = process.argv.slice(2);
const digest = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const components = JSON.parse(await readFile(path.join(engine, 'COMPONENTS.json'), 'utf8'));
components.client_source = revision;
components.server_source = revision;
components.server_binary_sha256 = await digest(path.join(engine, 'orca-webapp-server'));
components.source_archive_sha256 = await digest(path.join(engine, 'source.tar.gz'));
components.base_image = baseImage;

const metadata = JSON.stringify(components, null, 2) + '\n';
await writeFile(path.join(engine, 'COMPONENTS.json'), metadata);
await writeFile(path.join(web, 'COMPONENTS.json'), metadata);
await writeFile(path.join(web, 'REVISION.txt'), revision + '\n');

async function setModes(directory) {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await setModes(file);
    } else if (entry.isFile()) {
      await chmod(file, file === path.join(engine, 'orca-webapp-server') ? 0o755 : 0o644);
    } else {
      throw new Error(`Unexpected build output: ${file}`);
    }
  }
}

await setModes(web);
await setModes(engine);
