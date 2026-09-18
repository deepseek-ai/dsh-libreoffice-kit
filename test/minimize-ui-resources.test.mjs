import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('UI minimization rejects dependent groups and revisits files after later removals', () => {
  const result = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', String.raw`
import importlib.util
spec = importlib.util.spec_from_file_location('ui', 'scripts/minimize-ui-resources.py')
ui = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ui)
remaining = {'calc/a.ui', 'calc/b.ui', 'calc/shell.ui', 'unused/dialog.ui'}
trials = []
def attempt(group):
    candidate = remaining - set(group)
    # a may disappear only once b is gone; shell is always mandatory.
    accepted = 'calc/shell.ui' in candidate and ('calc/b.ui' not in candidate or 'calc/a.ui' in candidate)
    trials.append((group, accepted))
    if accepted:
        remaining.difference_update(group)
    return accepted
assert ui.greedy_minimize(sorted(remaining), attempt) == ['calc/shell.ui']
assert remaining == {'calc/shell.ui'}
assert trials[0][0] == ['calc/a.ui', 'calc/b.ui', 'calc/shell.ui']
assert trials.count((['calc/a.ui'], False)) == 1
assert trials.count((['calc/a.ui'], True)) == 1
xml = b'<html xmlns="http://www.w3.org/1999/xhtml"><head><meta content="time"/></head><body><page width="10" height="20"><word xMin="1">text</word></page></body></html>'
assert ui.word_layout(xml) == ui.word_layout(xml.replace(b'time', b'other-time'))
for change in [xml.replace(b'width="10"', b'width="11"'), xml.replace(b'xMin="1"', b'xMin="2"'), xml.replace(b'>text<', b'>changed<')]:
    assert ui.word_layout(xml) != ui.word_layout(change)
try:
    ui.word_layout(b'<html/>')
    raise AssertionError('empty output accepted')
except ValueError:
    pass
print('qualified')
`], { cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.trim(), 'qualified');
});
