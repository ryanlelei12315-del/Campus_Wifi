# Campus Wi-Fi Admin — V1

Manual-verification admin system for a small paid campus/hostel Wi-Fi service (~10–50+ users in Kenya).

Payments are collected manually via Airtel Money (customer dials `*334#`). The operator verifies the SMS transaction confirmation code and records it in the app. Network access control on the router is managed manually — this app is the **source of truth** for who should have access, not an automated router controller.

---

## Hardware & Network Architecture

- **Indoor CPE**: Airtel Smart Connect 5G/4G (`192.168.18.1`)
- **Outdoor CPE**: Upstream antenna / bridge (`192.168.254.1`)
- **Access Control Mode**: 100% manual MAC-address filtering / DHCP reservation. The Airtel CPE does not expose an automation API.
- **Operator Daily Workflow**:
  1. Customer requests access or renewal and sends funds via Airtel Money (`*334#`).
  2. Operator enters transaction code into **Record Payment**.
  3. Operator checks **Active Connections** on the dashboard, copies the customer's MAC address, and adds it to the router portal at `http://192.168.18.1`.
  4. When subscriptions expire, they appear under **Manual Router Action: Expired Connections** on the dashboard, alerting the operator to remove the MAC from the router whitelist.

---

## Quick Setup

### Prerequisites
- Node.js `v20` or `v22` LTS (Node 22 recommended). If using `fnm` or `nvm`, a `.node-version` file is included.

### Installation
```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env        # edit SESSION_SECRET at minimum

# 3. Seed initial admin & starter packages
npm run seed

# 4. Run automated test suite
npm test

# 5. Start application
npm start
```

Visit `http://localhost:3000` and log in. The seed script creates the default admin user:
- **Username**: `admin`
- **Password**: `changeme123` (or values configured in `SEED_ADMIN_USER` / `SEED_ADMIN_PASS`)

---

## Core Features & Workflows

### 1. Customers (Full CRUD)
- **List & View**: Search and view customer profiles, room identifiers, device names, and MAC addresses.
- **Add**: Creates customer with automatic MAC address normalization (`AA:BB:CC:DD:EE:FF`) and duplicate MAC check.
- **Edit & Status Toggle**: Update customer details (e.g. room changes, new device/MAC) and toggle account status (`ACTIVE` vs `DISABLED`).
- **History & Totals**: Complete chronological ledger of all verified payments and subscriptions per customer.

### 2. Record Payment & Renewal Logic
- **Transactional Atomic Execution**: Record payment and subscription updates succeed or fail together in a single SQLite transaction.
- **Extend-on-Renewal Rule**: If a customer pays while their subscription is still `ACTIVE`, the existing subscription row's `expiry_time` is extended by the new package's duration rather than restarting.
- **Financial Ledger Integrity**: `payments` remains strictly insert-only. Every payment references the customer, package, amount, timestamp, and the associated subscription ID.
- **Duplicate Protection**: `payments.reference_code` enforces a `UNIQUE` constraint, preventing duplicate entries of the same Airtel transaction. Form inputs are preserved if an error occurs.

### 3. Operator Dashboard
- **Financial Metrics**: Today's revenue, monthly revenue, monthly expenses, estimated monthly profit, and active/expiring customer counts.
- **Nairobi Timezone Accuracy**: SQLite queries apply a `+3 hours` modifier so payments recorded between midnight and 03:00 local time fall accurately into East Africa calendar days.
- **Active Connections**: Displays active customers with their Room, Device Name, and formatted MAC address for easy copying to the router.
- **Router Action Queue (Expired Connections)**: Surfaces subscriptions expired in the last 48 hours that have not renewed, prompting the admin to disconnect the MAC address on the CPE.
- **CPE Manager (Centralized)**: A single `/cpe` page manages **both gateways with live data, no iframes**:
  - **Live Gateway Integration**: the app logs into both ZTE gateways server-side and pulls real state —
    **Outdoor (ZTE MC8830, ubus JSON-RPC)**: RSRP/RSRQ/SINR/RSSI signal tiles, live download/upload throughput
    (`zwrt_data/get_wwandst`), and a double-confirmed **Restart** button (`zwrt_mc.device.manager/device_reboot`).
    **Indoor (Airtel Smart Hub, goform API)**: live connected-device list (`queryStationList`) and the current MAC
    block list (`wifi_mac_black_list`). Data refreshes every 10 s; login state is cached and failed logins back off
    for 10 min to avoid the firmware's 30-minute lockout.
  - **Credentials**: per-device passwords live only in `.env` — `CPE_ADMIN_PASSWORD` with `CPE_INDOOR_PASSWORD` /
    `CPE_OUTDOOR_PASSWORD` overrides (never hardcoded; never rendered into the page).
  - **Whitelist Helper**: A table of all active customers' MAC addresses with click-to-copy, ready to paste into the
    indoor CPE's MAC filter / DHCP reservation list.

---

## Technical Architecture & Invariants

| Component | Technology | Rationale |
| :--- | :--- | :--- |
| **Runtime** | Node.js (v22 LTS) + Express 5 | Zero-overhead, minimal memory footprint. |
| **Database** | SQLite via `better-sqlite3` 13 (WAL mode) | Low hosting cost, zero daemon overhead, fast local synchronous transactions with foreign keys enabled. |
| **Views** | Server-rendered EJS 6 | No frontend build step or bundle complexity. |
| **Password Hashing** | bcrypt 6 | Upgraded off the vulnerable `node-pre-gyp`/`tar` chain. |
| **Currencies** | Integer KSh | Plain integers avoid floating-point rounding errors. |
| **Timestamps** | UTC in SQLite, `Africa/Nairobi` in UI | All dates persisted in UTC (`YYYY-MM-DD HH:MM:SS`), parsed by `src/utils/formatDate.js`, and displayed in East Africa Time (`EAT`). |
| **Expiration** | Lazy in-process sweep | `sweepExpired()` runs on read paths (dashboard, customer detail, payment flows). No separate cron job or daemon required. |

---

## Directory Layout

```
campus-wifi/
├── data/
│   └── campus-wifi.sqlite    # SQLite database (auto-created)
├── public/
│   └── css/
│       └── style.css          # Minimalist dark theme & responsive styles
├── src/
│   ├── middleware/
│   │   └── auth.js            # Admin session guard & locals attach
│   ├── routes/
│   │   ├── auth.js            # Login & logout routes
│   │   ├── customers.js       # Customer CRUD (list, new, show, edit)
│   │   ├── dashboard.js       # Dashboard overview
│   │   ├── cpe.js             # Centralized CPE Manager (page + status JSON probe)
│   │   ├── packages.js        # Package listing
│   │   └── payments.js        # Payment entry & validation
│   ├── services/
│   │   ├── dashboardService.js   # Financial summaries & overview metrics
│   │   ├── zteClient.js          # ZTE protocol clients (goform + ubus JSON-RPC)
│   │   ├── cpeService.js         # Live CPE integration: stations, block list, signal, rates, reboot
│   │   ├── paymentService.js     # Atomic payment recording & duplicate defense
│   │   └── subscriptionService.js# Active extension, lazy sweep & disconnect queue
│   ├── utils/
│   │   └── formatDate.js      # UTC normalization & Africa/Nairobi Intl formatter
│   ├── views/
│   │   ├── customers/         # Customer EJS templates (list, new, show, edit)
│   │   ├── cpe/               # Centralized CPE Manager template
│   │   ├── packages/          # Package listing template
│   │   ├── partials/          # Header, navigation & footer partials
│   │   ├── payments/          # Payment entry template
│   │   ├── dashboard.ejs      # Main operations dashboard
│   │   └── login.ejs          # Admin login screen
│   ├── app.js                 # Express application & template locals configuration
│   ├── db.js                  # Database connection, WAL pragma & schema exec
│   ├── schema.sql             # Relational schema, checks, and foreign keys
│   ├── seed.js                # Default admin and package seed runner
│   └── server.js              # HTTP server entry point
├── test/
│   └── app.test.js            # End-to-end regression test suite
├── .env.example               # Configuration template
├── package.json
└── README.md
```

---

## Running Tests

To verify database integrity, renewal extension math, timezone offsets, and router queues:
```bash
npm test
```
