# DISK profile

DISK lets a user patch the structured profile in bank A and write it to the isolated data directory, then see the same identity after a reload.

## Sub-features

- `disk-open` opens DISK from the Editor tab and from `/disk`.
- `disk-bank-a` shows identity fields on `A·ID`.
- `disk-write-profile` enables `Write to disk` after an edit and toasts success.
- `disk-persist` keeps First name and headline after reload.
- `disk-criteria` (optional) writes target roles and locations on `D·CRIT`.

## How to get to it (user POV)

- Choose `DISK` in the Editor nav.
- Open `#/disk`.
- Run `/disk` from the footer composer (optional; prefer the tab for proof).

## Driving it with control-job-sequencer

Preconditions:

- Isolated instance is healthy.
- Bank A is the default (`A·ID`). Fresh profile has empty First name.

- **Open DISK.** Choose DISK. Run `browser goto --hash "#/disk"` then `browser wait --text "DISK · SAMPLE BANK"`. Fine-tune sidebar is visible; Master sample reads `Unnamed sample` or empty name.
- **Identity bank.** Choose `A·ID` if another bank is selected. Run `browser click --role button --name "A·ID"`. Fields `First name` and `Professional headline` are visible. Save bar shows `Synced` until dirty.
- **Edit identity.** Type a unique name. Run `browser fill --label "First name" --value "VerifyAda"` and `browser fill --label "Professional headline" --value "Verification engineer"`. Button `Write to disk` becomes enabled and the save bar shows `DIRTY`.
- **Write profile.** Choose `Write to disk`. Run `browser click --role button --name "Write to disk" --exact` then immediately `browser wait --text "Synced"`. The save bar returns to `Synced`. The `status` toast `Profile written to disk.` lasts about 2.8s — do not split it across a slow CLI round-trip.
- **Confirm persistence.** Reload DISK. Run `browser goto --hash "#/disk"` then `browser wait --text "VerifyAda"`. The First name field still contains `VerifyAda` and headline `Verification engineer`.
- **API second view.** Read the same profile through the UI proxy. Run `api --method GET --path /api/profile`. JSON `profile.identity.firstName` is `VerifyAda`.
- **Proof.** Capture the saved DISK view. Run `browser snapshot --path disk-profile/after-reload.aria.txt` and `browser screenshot --path disk-profile/after-reload.png`. Both identify TRACKER, DISK, and `VerifyAda`.

## Gotchas

- `Write to disk` is disabled until a field is dirty. Filling the current value does not enable it.
- The success toast vanishes in ~2.8s. Assert `Synced` and the field values (and reload) as lasting proof.
- `Write settings` and `Test link` live on the fine-tune sidebar and need an authenticated Pi model. They are not this feature. Collapse/open the sidebar with `Collapse fine-tune sidebar` / `Open fine-tune sidebar` if it covers the editor on a narrow viewport.
- Resume import lives on `A·ID` and calls Pi. Skip unless proving import.
- Do not write `data/profile.json` in the repo; only the isolated temp dir should change.
