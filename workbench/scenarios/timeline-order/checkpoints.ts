/** Selected complete installed snapshots retain all ordinary checkpoint distinctions.
 * Final rows cover all six orders in both cycles, including cancellation/refund/release. */
import { state, summary, tracking, type StateRow } from "./observations.js";
import { orderOne } from "./order-one.js";
export const firstCycleFinal: StateRow[] = [
  orderOne.cycleOneFinal,
  state(
    1,
    [102, 102],
    ["p7-1", "p26-1", "p32-1", "p33-1"],
    ["ordersW3", "paymentMissingW4", "inventoryW2"],
    [true, true],
  ),
  state(
    2,
    [105, 105],
    ["p10-1", "p26-2", "p32-2", "p33-2"],
    ["ordersW3", "paymentsW4", "inventoryW2"],
    [true, true],
  ),
  state(
    3,
    [108, 108],
    ["p13-1", "p26-3", "p32-3", "p33-3"],
    ["ordersW3", "paymentsW4", "inventoryW2"],
    [true, true],
  ),
  state(
    4,
    [111, 111],
    ["p16-1", "p26-4", "p32-4", "p33-4"],
    ["ordersW3", "paymentsW4", "inventoryW2"],
    [true, true],
  ),
  state(
    5,
    [114, 114],
    ["p25-0", "p26-5", "p32-5", "p33-5"],
    ["ordersW4", "paymentsW4", "inventoryW2"],
    [true, true],
  ),
];
export const secondCycleFinal: StateRow[] = [
  orderOne.cycleTwoFinal,
  state(
    1,
    [230, 230],
    ["p43-1", "p62-1", "p68-1", "p69-1"],
    ["ordersW6", "paymentMissingW8", "inventoryW4"],
    [true, true],
  ),
  state(
    2,
    [233, 233],
    ["p46-1", "p62-2", "p68-2", "p69-2"],
    ["ordersW6", "paymentsW8", "inventoryW4"],
    [true, true],
  ),
  state(
    3,
    [236, 236],
    ["p49-1", "p62-3", "p68-3", "p69-3"],
    ["ordersW6", "paymentsW8", "inventoryW4"],
    [true, true],
  ),
  state(
    4,
    [239, 239],
    ["p52-1", "p62-4", "p68-4", "p69-4"],
    ["ordersW6", "paymentsW8", "inventoryW4"],
    [true, true],
  ),
  state(
    5,
    [242, 242],
    ["p61-0", "p62-5", "p68-5", "p69-5"],
    ["ordersW8", "paymentsW8", "inventoryW4"],
    [true, true],
  ),
];
export const otherStates = {
  missingPayment: state(
    1,
    [31, 28],
    ["p7-1", "p12-0", "p8-2", "p6-1"],
    ["three", "paymentGap3", "one"],
    [true, true],
    ["delivery"],
  ),
  inventoryDisconnected: state(
    5,
    [70, 69],
    ["p19-1", "p24-0", "p20-2", "p18-2"],
    ["three", "three", "one"],
    [true, true],
    ["delivery"],
  ),
  cancelledAndRefunded: state(
    5,
    [78, 72],
    ["p25-0", "p26-5", "p20-2", "p18-2"],
    ["four", "four", "one"],
    [true, true],
    ["delivery", "inventory"],
  ),
};
export type Checkpoint = {
  id: string;
  atMs: number;
  row: StateRow;
  views: string[];
};
const both = [summary, tracking];
const check = (
  id: string,
  atMs: number,
  row: StateRow,
  views = both,
): Checkpoint => ({ id, atMs, row, views });
export const checkpoints: Checkpoint[] = [
  check("empty-baselines", 0, orderOne.empty),
  check("order-received-tracking-waits", 100, orderOne.accepted),
  check("payment-lookup", 3100, orderOne.payment),
  check("backup-before-primary", 6100, orderOne.backup),
  check("primary-takes-priority", 9100, orderOne.primary),
  check("dispatch-with-provisional-gap", 12100, orderOne.dispatchGap),
  check("inventory-releases-tracking", 15100, orderOne.gateOpen),
  check("late-order-closes-gap", 18100, orderOne.gapClosed),
  check("exact-retry-no-additional-effect", 21100, orderOne.gapClosed),
  check("primary-just-before-deadline", 24009, orderOne.gapClosed),
  // At this deadline expiry is delivered before the same-time payment2 frame.
  check("primary-at-deadline-with-input", 24010, orderOne.payment2),
  check("fresh-backup-does-not-refresh-primary", 24100, orderOne.payment2),
  check("inventory-just-before-deadline", 30009, orderOne.payment3),
  check("inventory-at-deadline", 30010, orderOne.inventoryExpired),
  check("order-two-missing-payment", 36100, otherStates.missingPayment),
  check("inventory-disconnect", 72100, otherStates.inventoryDisconnected),
  check(
    "orders-payments-continue-during-silence",
    78100,
    otherStates.cancelledAndRefunded,
  ),
  check("stock-and-primary-stale", 78100, orderOne.payment4),
  check("fresh-backup-stale-primary", 87100, orderOne.payment4),
  check("reconnect-does-not-refresh", 93100, orderOne.payment4),
  check("accepted-stock-refreshes", 96100, orderOne.stockRefreshed),
  check("primary-confirms-delivery", 99100, orderOne.delivered),
  ...firstCycleFinal.map((row) =>
    check(`cycle-one-final-${row.index + 1}`, 102100, row),
  ),
  ...firstCycleFinal.map((row) =>
    check(`unmapped-payment-leaves-order-${row.index + 1}`, 105100, row),
  ),
  check(
    "cycle-two-mixes-new-order-old-contributions",
    108100,
    orderOne.mixedCycle,
  ),
  check("previous-stock-just-before-expiry", 111009, orderOne.mixedCycle),
  check("previous-cycle-exact-repeat", 111100, orderOne.secondPayment),
  check(
    "previous-primary-expiry-with-backup-input",
    114010,
    orderOne.oldPrimaryExpired,
  ),
  check("second-cycle-primary-refresh", 117100, orderOne.secondPrimary),
  check("second-cycle-new-provisional-gap", 120100, orderOne.secondDispatchGap),
  check("gate-stays-open-across-cycles", 123100, orderOne.secondInventory),
  check("second-cycle-late-gap-closure", 126100, orderOne.secondGapClosed),
  check("second-cycle-exact-repeat", 129100, orderOne.secondGapClosed),
  check("second-cycle-primary-deadline-with-input", 132010, orderOne.payment6),
  check(
    "second-cycle-inventory-deadline",
    138010,
    orderOne.secondInventoryExpired,
  ),
  check("second-cycle-stale-primary-fresh-backup", 195100, orderOne.payment8),
  check("second-cycle-reconnect-without-refresh", 201100, orderOne.payment8),
  check("second-cycle-stock-refresh", 204100, orderOne.secondStockRefreshed),
  check("second-cycle-delivery-refresh", 207100, orderOne.secondDelivered),
  ...secondCycleFinal.map((row) =>
    check(`cycle-two-final-${row.index + 1}`, 213000, row),
  ),
];
