# Freebuff acceptance record

Use this checklist on a disposable project. Complete it separately for Freebuff Desktop plus the command line app. Record the date, operating system, Freebuff version, bridge version, MCP client version, plus the outcome of each step.

No live acceptance run is included with this source change. The local automated tests use synthetic backends. Do not copy their results into this record as live proof.

## Run record

Date

Operating system

Freebuff version

Bridge version

MCP client version

Backend under test

## Steps

1. Create a disposable project plus start one bridge session.
2. Send a harmless request that does not change files.
3. Confirm that progress appears, then confirm a terminal result.
4. Trigger an approval request. Confirm the turn remains visibly waiting.
5. Approve it in Freebuff. Confirm the same turn reaches a terminal state without a duplicate prompt.
6. Start another harmless request, cancel it, then confirm that Freebuff stopped it.
7. Restart the MCP client or bridge. Reconnect to the thread plus confirm that no duplicate request was sent.
8. Record any step that could not be completed, including the exact version plus a short error message with secrets removed.

## Results

Progress and completion

Approval and resume

Cancellation

Restart and reconnect

Duplicate work check

Notes
