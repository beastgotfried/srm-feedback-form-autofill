import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.resolve(testDirectory, '..');

const fixture = await readFile(path.join(testDirectory, 'fixture.html'), 'utf8');
const userscript = await readFile(path.join(appDirectory, 'srm-feedback-helper.user.js'), 'utf8');

function wait(milliseconds = 40) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function installLayoutShim(window) {
  const visibleRect = {
    x: 0,
    y: 0,
    top: 0,
    right: 100,
    bottom: 20,
    left: 0,
    width: 100,
    height: 20,
    toJSON() { return this; },
  };

  window.HTMLElement.prototype.getClientRects = function getClientRects() {
    if (this.hidden || this.closest('[hidden], [aria-hidden="true"]')) return [];
    const style = window.getComputedStyle(this);
    return style.display === 'none' || style.visibility === 'hidden' ? [] : [visibleRect];
  };
  window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return visibleRect;
  };
}

function helperUi(document) {
  const host = document.querySelector('#srm-feedback-helper-host');
  assert.ok(host, 'helper host should be mounted');
  assert.ok(host.shadowRoot, 'helper UI should use an open shadow root');
  return host.shadowRoot;
}

test('fills repeated ratings and blank comments, preserves values, and undoes safely', async () => {
  const window = new Window({ url: 'https://academia.srmist.edu.in/#Course_Feedback' });
  installLayoutShim(window);
  window.document.write(fixture);
  window.document.close();
  window.eval(userscript);
  await wait(80);

  const { document } = window;
  const ui = helperUi(document);
  assert.equal(ui.querySelector('#count').textContent, '3 rating · 3 text');
  assert.equal(ui.querySelectorAll('#cluster option').length, 1);
  assert.match(ui.querySelector('#cluster').textContent, /3 questions · 5 choices/);

  const answer = ui.querySelector('#answer');
  answer.value = '4';
  answer.dispatchEvent(new window.Event('change', { bubbles: true }));

  const comment = ui.querySelector('#comment');
  comment.value = 'Clear explanations throughout.';
  comment.dispatchEvent(new window.Event('input', { bubbles: true }));
  ui.querySelector('#fill').click();
  await wait(160);

  assert.equal(document.querySelector('input[name="question-1"][value="excellent"]').checked, true);
  assert.equal(document.querySelector('input[name="question-2"][value="excellent"]').checked, true);
  assert.equal(document.querySelector('input[name="question-3"][value="good"]').checked, true);
  assert.equal(document.querySelector('input[name="course"]:checked'), null);
  assert.equal(document.querySelector('#comment-blank').value, 'Clear explanations throughout.');
  assert.equal(document.querySelector('#comment-existing').value, 'Keep this text unchanged.');
  assert.equal(document.querySelector('#feedback-response').value, 'Clear explanations throughout.');
  assert.equal(document.querySelector('#search').value, '');
  assert.notEqual(document.body.dataset.submitted, 'true');
  assert.match(ui.querySelector('#status').textContent, /No submit control was clicked/);

  ui.querySelector('#undo').click();
  await wait(160);

  assert.equal(document.querySelector('input[name="question-1"]:checked'), null);
  assert.equal(document.querySelector('input[name="question-2"]:checked'), null);
  assert.equal(document.querySelector('input[name="question-3"][value="good"]').checked, true);
  assert.equal(document.querySelector('#comment-blank').value, '');
  assert.equal(document.querySelector('#comment-existing').value, 'Keep this text unchanged.');
  assert.equal(document.querySelector('#feedback-response').value, '');
  assert.equal(document.querySelector('#search').value, '');
  assert.notEqual(document.body.dataset.submitted, 'true');

  comment.value = '';
  comment.dispatchEvent(new window.Event('input', { bubbles: true }));
  ui.querySelector('#overwrite').checked = true;
  answer.value = '0';
  answer.dispatchEvent(new window.Event('change', { bubbles: true }));
  ui.querySelector('#fill').click();
  await wait(160);

  assert.equal(document.querySelector('input[name="question-1"][value="poor"]').checked, true);
  assert.equal(document.querySelector('input[name="question-2"][value="poor"]').checked, true);
  assert.equal(document.querySelector('input[name="question-3"][value="poor"]').checked, true);

  ui.querySelector('#undo').click();
  await wait(160);
  assert.equal(document.querySelector('input[name="question-1"]:checked'), null);
  assert.equal(document.querySelector('input[name="question-2"]:checked'), null);
  assert.equal(document.querySelector('input[name="question-3"][value="good"]').checked, true);

  await window.close();
});

test('excludes submit-capable ARIA radios and unrelated textareas', async () => {
  const window = new Window({ url: 'https://academia.srmist.edu.in/#Course_Feedback' });
  installLayoutShim(window);
  window.document.write(`
    <!doctype html>
    <form id="feedback">
      <div class="safe" role="radiogroup">
        <div role="radio" aria-checked="false">Poor</div>
        <div role="radio" aria-checked="false">Good</div>
      </div>
      <div class="safe" role="radiogroup">
        <div role="radio" aria-checked="false">Poor</div>
        <div role="radio" aria-checked="false">Good</div>
      </div>
      <div class="unsafe" role="radiogroup">
        <button role="radio" aria-checked="false">Poor</button>
        <button role="radio" aria-checked="false">Good</button>
      </div>
      <div class="unsafe" role="radiogroup">
        <button role="radio" aria-checked="false">Poor</button>
        <button role="radio" aria-checked="false">Good</button>
      </div>
      <textarea id="unrelated-notes"></textarea>
    </form>
  `);
  window.document.close();

  let submitCount = 0;
  window.document.querySelector('#feedback').addEventListener('submit', (event) => {
    event.preventDefault();
    submitCount += 1;
  });
  for (const group of window.document.querySelectorAll('.safe')) {
    for (const radio of group.querySelectorAll('[role="radio"]')) {
      radio.addEventListener('click', () => {
        for (const sibling of group.querySelectorAll('[role="radio"]')) {
          sibling.setAttribute('aria-checked', String(sibling === radio));
        }
      });
    }
  }

  window.eval(userscript);
  await wait(80);
  const ui = helperUi(window.document);
  assert.equal(ui.querySelector('#count').textContent, '2 rating');

  const answer = ui.querySelector('#answer');
  answer.value = '1';
  answer.dispatchEvent(new window.Event('change', { bubbles: true }));
  ui.querySelector('#comment').value = 'Do not copy this';
  ui.querySelector('#comment').dispatchEvent(new window.Event('input', { bubbles: true }));
  ui.querySelector('#fill').click();
  await wait(100);

  assert.equal(window.document.querySelectorAll('.safe [aria-checked="true"]').length, 2);
  assert.equal(window.document.querySelectorAll('.unsafe [aria-checked="true"]').length, 0);
  assert.equal(window.document.querySelector('#unrelated-notes').value, '');
  assert.equal(submitCount, 0);
  assert.match(ui.querySelector('#status').textContent, /No submit control was clicked/);

  await window.close();
});

test('does not merge repeated-size groups with different semantic scales', async () => {
  const window = new Window({ url: 'https://academia.srmist.edu.in/#Course_Feedback' });
  installLayoutShim(window);
  window.document.write(`
    <!doctype html>
    <form>
      <fieldset>
        <label><input type="radio" name="scale-a" value="low">Low</label>
        <label><input type="radio" name="scale-a" value="medium">Medium</label>
        <label><input type="radio" name="scale-a" value="high">High</label>
      </fieldset>
      <fieldset>
        <label><input type="radio" name="scale-b" value="yes">Yes</label>
        <label><input type="radio" name="scale-b" value="maybe">Maybe</label>
        <label><input type="radio" name="scale-b" value="no">No</label>
      </fieldset>
    </form>
  `);
  window.document.close();
  window.eval(userscript);
  await wait(80);

  const ui = helperUi(window.document);
  assert.equal(ui.querySelector('#count').textContent, 'No matches');
  assert.equal(ui.querySelector('#fill').disabled, true);
  assert.equal(window.document.querySelector('input:checked'), null);

  await window.close();
});

test('fills Course Feedback Select2 backing selects and Comments without clicking widgets', async () => {
  const window = new Window({ url: 'https://academia.srmist.edu.in/#Course_Feedback' });
  installLayoutShim(window);

  const ratingOptions = `
    <option value="">--Select--</option>
    <option value="average">Average</option>
    <option value="excellent">Excellent</option>
    <option value="good">Good</option>
    <option value="poor">Poor</option>
    <option value="very-good">Very Good</option>
  `;
  const ratingCell = (id, selected = '') => {
    const options = selected
      ? ratingOptions.replace(`value="${selected}"`, `value="${selected}" selected`)
      : ratingOptions;
    const label = selected === 'excellent' ? 'Excellent' : '--Select--';
    return `
      <td>
        <select id="${id}" class="select2-offscreen rating-select">${options}</select>
        <div id="s2id_${id}" class="select2-container">
          <a class="select2-choice"><span class="select2-chosen">${label}</span></a>
        </div>
      </td>
    `;
  };

  window.document.write(`
    <!doctype html>
    <style>
      .select2-offscreen { display: none; }
      .select2-container { display: inline-block; width: 220px; height: 32px; }
    </style>
    <form id="course-feedback">
      <label>Feedback Number <input id="feedback-number" name="Feedback_Number" type="text"></label>
      <table>
        <thead>
          <tr><th>Course Code</th><th>1 Punctuality</th><th>2 Sincerity</th><th>Comments</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <select id="course-1" class="select2-offscreen"><option value="c1" selected>21ABC101</option></select>
              <div id="s2id_course-1" class="select2-container"><span class="select2-chosen">21ABC101</span></div>
            </td>
            ${ratingCell('rating-1a')}
            ${ratingCell('rating-1b')}
            <td><textarea id="row-text-1"></textarea></td>
          </tr>
          <tr>
            <td>
              <select id="course-2" class="select2-offscreen"><option value="c2" selected>21XYZ202</option></select>
              <div id="s2id_course-2" class="select2-container"><span class="select2-chosen">21XYZ202</span></div>
            </td>
            ${ratingCell('rating-2a')}
            ${ratingCell('rating-2b', 'excellent')}
            <td><textarea id="row-text-2"></textarea></td>
          </tr>
        </tbody>
      </table>
      <select id="hidden-no-widget" style="display:none">${ratingOptions}</select>
      <button id="submit-course-feedback" type="submit">Submit</button>
    </form>
  `);
  window.document.close();
  window.document.querySelector('#rating-2b').value = 'excellent';

  let widgetClickCount = 0;
  let submitCount = 0;
  for (const widget of window.document.querySelectorAll('.select2-container')) {
    widget.addEventListener('click', () => { widgetClickCount += 1; });
  }
  for (const select of window.document.querySelectorAll('.rating-select')) {
    select.addEventListener('change', () => {
      window.document.querySelector(`#s2id_${select.id} .select2-chosen`).textContent =
        select.selectedOptions[0]?.textContent || '--Select--';
    });
  }
  window.document.querySelector('#course-feedback').addEventListener('submit', (event) => {
    event.preventDefault();
    submitCount += 1;
  });

  window.eval(userscript);
  await wait(80);
  const ui = helperUi(window.document);

  assert.equal(ui.querySelector('#count').textContent, '4 rating · 2 text');
  assert.match(ui.querySelector('#cluster').textContent, /4 rating fields/);
  assert.equal(ui.querySelector('#answer').selectedOptions[0].textContent, '3 — Good');
  assert.equal(ui.querySelector('#comment').value, 'Good');

  ui.querySelector('#fill').click();
  await wait(180);

  assert.equal(window.document.querySelector('#rating-1a').value, 'good');
  assert.equal(window.document.querySelector('#rating-1b').value, 'good');
  assert.equal(window.document.querySelector('#rating-2a').value, 'good');
  assert.equal(window.document.querySelector('#rating-2b').value, 'excellent');
  assert.equal(window.document.querySelector('#course-1').value, 'c1');
  assert.equal(window.document.querySelector('#course-2').value, 'c2');
  assert.equal(window.document.querySelector('#feedback-number').value, '');
  assert.equal(window.document.querySelector('#row-text-1').value, 'Good');
  assert.equal(window.document.querySelector('#row-text-2').value, 'Good');
  assert.equal(widgetClickCount, 0);
  assert.equal(submitCount, 0);

  ui.querySelector('#undo').click();
  await wait(180);
  assert.equal(window.document.querySelector('#rating-1a').selectedIndex, 0);
  assert.equal(window.document.querySelector('#rating-1b').selectedIndex, 0);
  assert.equal(window.document.querySelector('#rating-2a').selectedIndex, 0);
  assert.equal(window.document.querySelector('#rating-2b').value, 'excellent');
  assert.equal(window.document.querySelector('#row-text-1').value, '');
  assert.equal(window.document.querySelector('#row-text-2').value, '');
  assert.equal(window.document.querySelector('#feedback-number').value, '');
  assert.equal(widgetClickCount, 0);
  assert.equal(submitCount, 0);

  await window.close();
});

test('does not mount on the old Class Feedback route', async () => {
  const window = new Window({ url: 'https://academia.srmist.edu.in/#Class_Feedback' });
  installLayoutShim(window);
  window.document.write('<!doctype html><p>Old route</p>');
  window.document.close();
  window.eval(userscript);
  await wait(60);
  assert.equal(window.document.querySelector('#srm-feedback-helper-host'), null);
  await window.close();
});
