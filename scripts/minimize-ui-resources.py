#!/usr/bin/env python3
"""Requalify the headless .ui allowlist with a real native helper and Poppler.

Only an isolated copy is changed. Baseline and every deletion trial use a fresh
process, profile and PDF per input, and compare page geometry, text and word boxes.
The result is corpus-specific, not proof for every document or backend.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET


FORMATS = {'.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def word_layout(xml):
    root = ET.fromstring(xml)
    pages = []
    for page in root.iter('{http://www.w3.org/1999/xhtml}page'):
        words = [(word.attrib, word.text or '')
                 for word in page.iter('{http://www.w3.org/1999/xhtml}word')]
        pages.append((page.attrib, words))
    if not pages or not any(words for _, words in pages):
        raise ValueError('PDF has no extractable words; use a text-bearing corpus')
    # Ignore PDF producer/time metadata, but preserve page/word order and boxes.
    return digest(json.dumps(pages, sort_keys=True, ensure_ascii=False).encode())


def greedy_minimize(paths, attempt):
    """Try directories first, then files; revisit retained files until stable."""
    retained = set(paths)
    directories = {parent.as_posix() for name in paths
                   for parent in Path(name).parents if parent != Path('.')}
    for directory in sorted(directories, key=lambda name: (name.count('/'), name)):
        group = sorted(name for name in retained if name.startswith(directory + '/'))
        if group and attempt(group):
            retained.difference_update(group)
    changed = True
    while changed:
        changed = False
        for name in sorted(retained):
            if attempt([name]):
                retained.remove(name)
                changed = True
    return sorted(retained)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', type=Path, required=True, help='native engine package')
    parser.add_argument('--ui-source', type=Path, required=True,
                        help='complete, unpruned soffice.cfg from the same Core build')
    parser.add_argument('--fixtures', type=Path, required=True, help='directory covering all six Office formats')
    parser.add_argument('--output', type=Path, required=True, help='new evidence directory')
    parser.add_argument('--mode', choices=['minimize', 'verify'], default='minimize')
    parser.add_argument('--timeout', type=int, default=90, help='seconds per helper or Poppler call')
    parser.add_argument('--font-file', type=Path, action='append', default=[])
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error('--timeout must be positive')
    package, source, corpus, output = [path.resolve() for path in
                                      (args.package, args.ui_source, args.fixtures, args.output)]
    for path in [package, source, corpus]:
        if path == output or path in output.parents or output in path.parents:
            parser.error('--output must be separate from all input directories')
    manifest = json.loads((package / 'prebuilds.json').read_text())
    if manifest['engine']['kind'] != 'native':
        parser.error('minimization requires a matching-host native engine')
    def package_path(name):
        path = Path(name)
        if path.is_absolute() or '..' in path.parts:
            parser.error('engine paths must be package-relative')
        return path
    program = package_path(manifest['engine']['programDirectory'])
    helper = package_path(manifest['engine']['executable'])
    ui_relative = program.parent / ('Resources' if manifest['platform'].startswith('darwin-') else 'share') / 'config/soffice.cfg'
    inputs = sorted(path for path in corpus.rglob('*') if path.suffix.lower() in FORMATS and path.is_file())
    if {path.suffix.lower() for path in inputs} != FORMATS:
        parser.error('the corpus must contain DOC/DOCX/XLS/XLSX/PPT/PPTX')
    layouts = sorted(path.relative_to(source).as_posix() for path in source.rglob('*.ui') if path.is_file())
    policy = Path(__file__).resolve().parents[1] / 'engine/ui-resource-policy.mjs'
    expected = json.loads(subprocess.check_output([
        'node', '--input-type=module', '-e',
        'const m = await import(process.argv[1]); console.log(JSON.stringify(m.requiredUiResources));',
        policy.as_uri()], text=True))
    if len(layouts) <= len(expected) or (args.mode == 'verify' and not set(expected) < set(layouts)):
        parser.error('--ui-source must include the required layouts and the unpruned layouts')
    fonts = [path.resolve(strict=True) for path in args.font_file]
    # Keep only OS execution settings; do not pass credentials or loader overrides.
    env = {key: value for key, value in os.environ.items() if key in {
        'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR',
        'LANG', 'LC_ALL', 'TZ', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'}}
    poppler = subprocess.run(['pdftotext', '-v'], capture_output=True, env=env, check=True)
    output.mkdir(parents=True, exist_ok=False)
    candidate = output / 'candidate'
    candidate.mkdir()
    for name in ['bin', 'program']:
        shutil.copytree(package / name, candidate / name, symlinks=False)
    ui = candidate / ui_relative
    shutil.rmtree(ui, ignore_errors=True)
    shutil.copytree(source, ui, symlinks=False)
    inventory = {name: {'bytes': (source / name).stat().st_size,
                        'sha256': digest((source / name).read_bytes())} for name in layouts}
    evidence = {
        'mode': args.mode, 'coreRevision': manifest['source']['revision'],
        'platform': manifest['platform'], 'host': platform.platform(),
        'helperSha256': digest((candidate / helper).read_bytes()),
        'packageManifestSha256': digest((package / 'prebuilds.json').read_bytes()),
        'policySha256': digest(policy.read_bytes()),
        'poppler': (poppler.stdout + poppler.stderr).decode().splitlines()[0],
        'fonts': [{'name': path.name, 'sha256': digest(path.read_bytes())} for path in fonts],
        'inputs': [{'file': path.relative_to(corpus).as_posix(), 'sha256': digest(path.read_bytes())} for path in inputs],
        'originalUi': inventory, 'trials': [],
    }
    def save():
        (output / 'report.json').write_text(json.dumps(evidence, indent=2) + '\n')
    def convert_all(label):
        fingerprints = []
        with tempfile.TemporaryDirectory(prefix='conversion-', dir=output) as work:
            for index, path in enumerate(inputs):
                pdf = Path(work) / f'{index}.pdf'
                command = [str(candidate / helper), '--program-directory', str(candidate / program),
                           '--input-path', str(path), '--output-path', str(pdf),
                           '--profile-directory', str(Path(work) / f'profile-{index}'),
                           '--max-output-bytes', str(512 * 1024 * 1024), '--max-image-resolution', '192']
                for font in fonts:
                    command += ['--font-file', str(font)]
                for tool, argv in [('helper', command), ('pdftotext', ['pdftotext', '-bbox', str(pdf), '-'])]:
                    try:
                        result = subprocess.run(argv, capture_output=True, timeout=args.timeout, env=env)
                    except subprocess.TimeoutExpired as error:
                        raise RuntimeError(f'{path.name}: {tool} timeout') from error
                    if result.returncode:
                        (output / f'{label}-{index}-{tool}.log').write_bytes(result.stdout + result.stderr)
                        raise RuntimeError(f'{path.name}: {tool} exit {result.returncode}')
                if label.startswith('baseline'):
                    (output / f'{label}-{index}.xml').write_bytes(result.stdout)
                fingerprints.append(word_layout(result.stdout))
        return fingerprints
    save()
    baseline = convert_all('baseline')
    repeated = convert_all('baseline-repeat')
    if repeated != baseline:
        unstable = [inputs[index].name for index, value in enumerate(repeated) if value != baseline[index]]
        raise RuntimeError(f'Baseline text/word coordinates are not deterministic: {unstable}; inspect baseline XML files')
    evidence['baselineLayoutSha256'] = baseline
    save()
    def attempt(group):
        for name in group:
            (ui / name).unlink()
        accepted = False
        failure = None
        try:
            accepted = convert_all(f'trial-{len(evidence["trials"])}') == baseline
            if not accepted:
                failure = 'page geometry, text or word coordinates changed'
        except (RuntimeError, ValueError, ET.ParseError) as error:
            failure = str(error)
        finally:
            if not accepted:
                for name in group:
                    shutil.copyfile(source / name, ui / name)
        evidence['trials'].append({'removed': group, 'accepted': accepted, 'failure': failure})
        save()
        print(f'trial {len(evidence["trials"])}: {"removed" if accepted else "retained"} {len(group)} layouts', flush=True)
        return accepted
    if args.mode == 'verify':
        if not attempt(sorted(set(layouts) - set(expected))):
            raise RuntimeError('The checked-in allowlist failed conversion equivalence')
        retained = sorted(expected)
    else:
        retained = greedy_minimize(layouts, attempt)
    if convert_all('final') != baseline:
        raise RuntimeError('Final conversion differs from baseline')
    evidence.update(retainedUi=retained, matchesAllowlist=retained == sorted(expected),
                    removedFiles=len(layouts) - len(retained),
                    removedBytes=sum(item['bytes'] for name, item in inventory.items() if name not in retained),
                    retainedBytes=sum(inventory[name]['bytes'] for name in retained),
                    finalLayoutSha256=baseline, status='complete')
    save()
    print(json.dumps({key: evidence[key] for key in ['retainedUi', 'matchesAllowlist', 'removedFiles', 'removedBytes', 'retainedBytes']}))
    if not evidence['matchesAllowlist']:
        raise SystemExit('Minimized layouts differ: review report.json and update the policy before packaging')


if __name__ == '__main__':
    main()
