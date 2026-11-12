// Display fixtures only. These are not a second implementation of ZooGlass rules.
export const fixtures = {
  normal: {
    label: "Reporting normally",
    order: "Dispatched",
    payment: "Authorised",
    stock: "Reserved",
    delivery: "In transit",
    tone: "good",
    badge: "Reporting normally",
    age: "Updated 4 seconds ago",
    explanation:
      "The latest accepted contributions are shown together. Payment and stock can change without replacing the order state.",
    trackingReady: true,
    notice: "Fresh courier report received. Delivery remains in transit.",
  },
  waiting: {
    label: "Waiting for stock",
    order: "Accepted",
    payment: "Authorised",
    stock: "Not received",
    delivery: "Not received",
    tone: "quiet",
    badge: "Partial information",
    age: "Order received 6 seconds ago",
    explanation:
      "Operations can show the order and payment now. Tracking withholds its values until both order and stock have contributed.",
    trackingReady: false,
    notice:
      "Order and payment received. The stock contribution has not arrived.",
  },
  stale: {
    label: "Stale stock",
    order: "Packing",
    payment: "Authorised",
    stock: "Reserved",
    delivery: "Not received",
    tone: "warn",
    badge: "Stock is stale",
    age: "Stock last reported 42 seconds ago",
    explanation:
      "The last accepted stock value is retained. Its age does not confirm that stock is still reserved, or that the source is disconnected.",
    trackingReady: true,
    notice:
      "Stock passed its receipt-age threshold. The last value remains visible.",
  },
  missing: {
    label: "Missing payment event",
    order: "Dispatched",
    payment: "Authorised",
    stock: "Reserved",
    delivery: "In transit",
    tone: "warn",
    badge: "Payment delivery gap",
    age: "Payment sequence 3 accepted",
    explanation:
      "Payment report 2 is confirmed missing after the source watermark. Report 3 supplies the latest payment value; it does not repair the gap.",
    trackingReady: true,
    notice: "Payment report 3 received; report 2 remains confirmed missing.",
  },
  courier: {
    label: "Stale primary courier",
    order: "Dispatched",
    payment: "Authorised",
    stock: "Reserved",
    delivery: "In transit",
    tone: "warn",
    badge: "Selected courier is stale",
    age: "Primary reported 42 seconds ago · backup reported 3 seconds ago",
    explanation:
      "Primary courier remains selected by configured priority. Its in-transit report is stale. The fresh backup reports delivered, but silence does not automatically switch authority.",
    couriers: {
      primary: "In transit · stale · 42 seconds ago",
      backup: "Delivered · fresh · 3 seconds ago",
    },
    trackingReady: true,
    notice:
      "Fresh backup received. The stale primary remains selected; no automatic fallback.",
  },
  mixed: {
    label: "Mixed cycles",
    order: "Accepted",
    payment: "Refunded",
    stock: "Released",
    delivery: "Delivered",
    tone: "quiet",
    badge: "Previous-cycle contributions",
    age: "Order: cycle 2 · other fields: cycle 1",
    explanation:
      "This synthetic slot has started a new cycle. Previous contributions remain until replaced. They are labelled and are not evidence that this new order is fulfilled.",
    trackingReady: true,
    notice:
      "New cycle started. Earlier-cycle contributions remain explicitly labelled.",
  },
  disconnected: {
    label: "Viewer disconnected",
    order: "Dispatched",
    payment: "Authorised",
    stock: "Reserved",
    delivery: "Collected",
    tone: "offline",
    badge: "Viewer disconnected",
    age: "Saved snapshot · updates unavailable",
    explanation:
      "This unprotected demo retains a clearly labelled snapshot while disconnected. Reconnection replaces it with a fresh baseline. A protected viewer would clear its data.",
    trackingReady: true,
    notice: "Viewer disconnected. All displayed orders are saved snapshots.",
  },
};

export const orders = [
  {
    id: "1042",
    item: "Arc desk lamp",
    initials: "AL",
    colour: "sand",
    destination: "Brighton",
    fixture: "normal",
  },
  {
    id: "1043",
    item: "Studio headphones",
    initials: "SH",
    colour: "blue",
    destination: "Bristol",
    fixture: "missing",
  },
  {
    id: "1044",
    item: "Pour-over set",
    initials: "PS",
    colour: "clay",
    destination: "York",
    fixture: "waiting",
  },
  {
    id: "1045",
    item: "Everyday backpack",
    initials: "EB",
    colour: "sage",
    destination: "Bath",
    fixture: "stale",
  },
  {
    id: "1046",
    item: "Reading light",
    initials: "RL",
    colour: "mauve",
    destination: "Oxford",
    fixture: "mixed",
  },
  {
    id: "1047",
    item: "Desk organiser",
    initials: "DO",
    colour: "sand",
    destination: "Exeter",
    fixture: "normal",
  },
];
export const checkpoints = [
  "waiting",
  "normal",
  "missing",
  "stale",
  "courier",
  "mixed",
  "disconnected",
];
