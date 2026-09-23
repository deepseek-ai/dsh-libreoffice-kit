import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

test('font regression preserves receipt bytes before Windows checkout and baseline creation', () => {
  const workflow = yaml.load(readFileSync(new URL('../.github/workflows/font-cache-regression.yml', import.meta.url), 'utf8'));
  const steps = workflow.jobs.render.steps;
  const preserve = steps.findIndex(step => step.run === 'git config --global core.autocrlf false');
  const checkout = steps.findIndex(step => step.uses?.startsWith('actions/checkout@'));
  const baseline = steps.findIndex(step => step.run?.includes('git worktree add'));
  assert.ok(preserve >= 0 && preserve < checkout && checkout < baseline);
  assert.equal(steps[preserve].if, "runner.os == 'Windows'");
  assert.equal(steps[checkout].with.ref, '${{ inputs.source_ref || github.ref }}');
  assert.equal(steps[checkout].with['persist-credentials'], false);
  assert.equal(workflow.on.workflow_dispatch.inputs.source_ref.type, 'string');
  assert.equal(workflow.permissions.contents, 'read');
});
