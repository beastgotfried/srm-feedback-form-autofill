# SRM Academia Course Feedback Helper

A local Tampermonkey userscript for filling repeated rating dropdowns and comment boxes on SRM Academia's Course Feedback page. It works inside the browser session where you are already signed in.

The helper intentionally does **not**:

- store or request login credentials, cookies, OTPs, or CAPTCHA responses;
- search for or click Submit, Save, Next, course navigation, or pagination controls;
- change an existing rating unless you enable **Replace rating answers already selected**;
- replace existing comment text.

## Install

1. Install the Tampermonkey extension in the browser you use for Academia.
2. Open the [userscript installer](https://raw.githubusercontent.com/beastgotfried/srm-feedback-form-autofill/main/srm-feedback-helper.user.js) and approve Tampermonkey's installation prompt.
3. Open <https://academia.srmist.edu.in/#Course_Feedback> in the same browser and sign in normally.
4. Refresh the Course Feedback page if the helper does not appear after the form finishes loading.

If the installer is shown as plain text, create a new Tampermonkey script, replace its example content with [`srm-feedback-helper.user.js`](./srm-feedback-helper.user.js), and save it.

Tampermonkey should show that the script is active only on `academia.srmist.edu.in`.

## Use

1. Wait for the small **Feedback helper** panel in the lower-right corner.
2. Check the detected question set. If the form contains more than one repeated rating scale, choose the correct set.
3. Confirm the rating. It defaults to **Good**; the available scale is Average, Excellent, Good, Poor, and Very Good.
4. Confirm the comment text. It defaults to **Good** and is repeated into every blank Comments cell; existing text is preserved.
5. Select **Fill form**.
6. Review every answer and comment in the original form, then submit manually if everything is correct.

The portal can still run its own autosave or change handlers when a field changes. The helper does not disable those site behaviors; it only avoids targeting submission and navigation controls itself.

The comment feature repeats one exact comment. If the boxes ask different written questions, leave this field empty until a per-question mapping has been added from a redacted DOM sample.

**Undo last fill** restores only controls changed by the most recent fill. For custom ARIA widgets that cannot safely return to an unanswered state, reload the page instead.

## If the helper finds no rating fields

1. Wait for the entire form to render and select **Rescan**.
2. Select **Copy diagnostics** and send the copied JSON back for selector refinement.
3. Include a redacted screenshot of one question row if possible.

The diagnostic report excludes cookies, browser storage, and credentials. It includes derived option labels and structural page details that may contain form text or identifiers, so inspect and redact it before sharing.

An inaccessible-frame count usually means the form lives on another origin. This version cannot fill a cross-origin child frame. Share the diagnostic report or the frame's origin (not its full authenticated URL); supporting it requires a separate, explicitly frame-scoped configuration.

## Current detection rules

- Native-`<select>`-backed Zoho/Select2 rating dropdowns are supported; the visible dropdown widgets are not clicked. If this portal build uses hidden inputs instead of backing selects, diagnostics will report zero rating groups and the adapter will need one more selector pass.
- Native `input[type="radio"]` groups and safe accessible `[role="radiogroup"]` widgets remain supported as a fallback.
- Only visible `textarea` and text-input elements whose attributes or labels identify them as feedback/comment/remark fields are supported.
- Course rating dropdowns must contain exactly the five known rating labels. Course Code, Academic Year, and unrelated selectors are therefore excluded.
- Radio fallbacks are offered only when the same semantic scale repeats.
- Same-origin frames and open shadow roots are inspected.
- Hidden, disabled, security/login, and navigation controls are ignored.
- Only controls currently rendered in the page can be filled. Paginated or virtualized questions require a separate pass after they appear.

## Local checks

```bash
npm install
npm test
```

The DOM test uses a synthetic feedback form. It verifies rating and comment fill, preservation of existing values, undo, and that no submit control is clicked.
