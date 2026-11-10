import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';

/** Run SITNA postinstall patches against an in-memory copy, never node_modules. */
export function createSitnaPatchSandbox() {
  const patchedFiles = new Map<string, string>();
  const virtualFs = {
    existsSync: (file: string) => patchedFiles.has(file) || existsSync(file),
    readFileSync: (file: string, encoding: BufferEncoding) =>
      patchedFiles.get(file) ?? readFileSync(file, encoding),
    writeFileSync: (file: string, contents: string) => patchedFiles.set(file, contents)
  };

  const read = (file: string) => virtualFs.readFileSync(join(__dirname, '../node_modules/api-sitna', file), 'utf8');

  // Reconstruct the two input states without retaining a vendored dependency or
  // depending on whether the developer has already run the latest postinstall.
  function wfsBaseline(version: 'clean' | 'v1'): void {
    type Replacement = { before: string; after: string; done?: string };
    const groups: { file: string; replacements: Replacement[] }[] = [];
    const script = readFileSync(join(__dirname, 'patch-sitna-wfs.js'), 'utf8');
    runInNewContext(script.slice(script.indexOf('// Permission hooks')), {
      patchFile: (file: string, replacements: Replacement[]) => groups.push({ file, replacements })
    });
    const byFile = new Map<string, Replacement[]>();
    for (const { file, replacements } of groups) byFile.set(file, [...(byFile.get(file) ?? []), ...replacements]);
    for (const [file, replacements] of byFile) {
      let source = read(file).replace(/\r\n/g, '\n');
      // Patch groups can replace text introduced by earlier groups. Undo the
      // complete chain repeatedly so those earlier anchors can be restored.
      for (let pass = 0; pass < groups.length; pass++) {
        const previous = source;
        for (const { before, after } of [...replacements].reverse()) source = source.split(after).join(before);
        if (source === previous) break;
      }
      virtualFs.writeFileSync(join(__dirname, '../node_modules/api-sitna', file), source);
    }
    if (version === 'clean') return;
    // v1 consists of the original groups, without the generation/reader upgrade,
    // definitive importer guard or final capability bump.
    for (const [index, { file, replacements }] of groups.entries()) {
      if (index === 1 || index === groups.length - 1) continue;
      let source = read(file);
      for (const { before, after, done } of replacements) {
        if (after.includes('self.editControl.importFeatures = function')) continue;
        if (done && source.includes(done) || source.includes(after)) continue;
        if (!source.includes(before)) throw new Error(`Cannot reconstruct v1 ${file}`);
        source = source.split(before).join(after);
      }
      virtualFs.writeFileSync(join(__dirname, '../node_modules/api-sitna', file), source);
    }
  }

  return {
    wfsBaseline,
    run(script: string): void {
      const source = readFileSync(join(__dirname, script), 'utf8');
      const exit = {};
      try {
        runInNewContext(source, {
          __dirname,
          require: (name: string) => name === 'fs' ? virtualFs : require(name),
          process: { exit: () => { throw exit; } },
          console
        });
      } catch (error) {
        if (error !== exit) throw error;
      }
    },
    read(file: string): string {
      return read(file);
    }
  };
}
