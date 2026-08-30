# ORDER applications

ORDER is the application board: SELECT, DRAFT, READY, APPLIED, PHRASE, and OUT slots. On a fresh isolated launch every slot is empty and the board scrolls sideways.

## Sub-features

- `order-open` opens ORDER from the Editor tab, `#/order`, and `03 DOCS`.
- `order-empty-slots` shows empty copy per stage.
- `order-focus-draft` focuses DOCS (B00–B01) from `03 DOCS` or `#/order/draft`.
- `order-focus-ready` focuses APPLY from `04 APPLY` or `#/order/ready`.
- `order-focus-follow` focuses FOLLOW from `#/order/follow`.
- `order-filter` searches and filters stages from `Filter ORDER rows`.

## How to get to it (user POV)

- Choose `ORDER` in the Editor nav.
- Choose `03 DOCS` or `04 APPLY` in the Song chain.
- Open `#/order`, `#/order/draft`, `#/order/ready`, or `#/order/follow`.

## Driving it with control-job-sequencer

Preconditions:

- Isolated instance is healthy.
- Inbox has no Selected/Drafting/Ready/Applied jobs.

- **Open ORDER.** Choose ORDER. Run `browser goto --hash "#/order"` then `browser wait --text "ORDER LIST"`. List named `Song order list` is visible.
- **Empty slots.** Read the board. Text includes `No selected rows`, `No drafting rows`, `No ready rows`, `No applied rows`, and `No outcomes yet`.
- **DOCS focus.** Choose `03 DOCS`. Run `browser click --role button --name "03 DOCS" --exact`. Header span includes `DOCS · posisi B00–B01`.
- **APPLY hash.** Open ready focus. Run `browser goto --hash "#/order/ready"` then `browser wait --text "APPLY · posisi B02"`.
- **FOLLOW hash.** Open follow-up focus. Run `browser goto --hash "#/order/follow"` then `browser wait --text "FOLLOW · posisi B03–B04"`. Follow-up editor empty copy mentions marking Applied first.
- **Proof.** Capture the empty board. Run `browser snapshot --path order-applications/empty.aria.txt` and `browser screenshot --path order-applications/empty.png`. Artifacts show TRACKER, `ORDER LIST`, and at least one `No … rows` slot.

## Gotchas

- Populated ORDER rows require a job that reached Selected via SAMPLE (`Arm SELECT`), not a DB write.
- Generate documents from ORDER is a Pi workflow. Skip unless proving generate with auth.
- The board is supposed to overflow horizontally; that is not a layout bug. Page-level horizontal overflow still is.
