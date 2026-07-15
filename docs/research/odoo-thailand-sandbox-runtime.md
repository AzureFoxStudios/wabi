# Odoo Thailand Sandbox Runtime Notes

Date: 2026-06-14

## Sandbox location

Runtime sandbox lives outside the Wabi repo:

- `/var/home/Ronin/odoo-thailand-sandbox`

This keeps Docker volumes and fake Odoo database files out of the Wabi source tree.

## Purpose

Use Ronin as a completely isolated fake-data sandbox to determine whether Odoo CE + Thailand localization + OCA Thailand modules can handle Thai construction-material workflows and Thai legal/tax outputs from inside Odoo.

## Access

- Local URL: http://127.0.0.1:8069
- Database manager: http://127.0.0.1:8069/web/database/manager
- Bound only to localhost in `docker-compose.yml`.
- Not exposed to the LAN by default.
- Verified reachable on 2026-06-14: root URL returned HTTP 303 redirect, database manager returned HTTP 200 and displayed the Create Database form.

## Safety constraints

- Fake data only.
- No business network/data import.
- No connection to Conmat/Express.
- No Wabi runtime integration yet.
- No production deployment.

## Files created

- `/var/home/Ronin/odoo-thailand-sandbox/docker-compose.yml`
- `/var/home/Ronin/odoo-thailand-sandbox/config/odoo.conf`
- `/var/home/Ronin/odoo-thailand-sandbox/README.md`

## Container services

- `odoo-thailand-db` — PostgreSQL 16
- `odoo-thailand-ce` — Odoo CE 18.0

## Data storage

- `odoo-thailand-sandbox_odoo_thailand_postgres` — Podman/Docker named volume for PostgreSQL database files
- `odoo-thailand-sandbox_odoo_thailand_odoo` — Podman/Docker named volume for Odoo filestore/session data
- `/var/home/Ronin/odoo-thailand-sandbox/addons/` — reserved for later OCA extra addons after base Odoo is verified
- `/var/home/Ronin/odoo-thailand-sandbox/config/odoo.conf` — reserved config file, not mounted during first boot

Named volumes are used for database/app data because rootless Podman hit bind-mount write permission issues with the official PostgreSQL image. First boot intentionally avoids config/addon bind mounts because `/var/home/Ronin` has restrictive traversal permissions for rootless containers; add OCA addons after the base UI is healthy.

## Commands

Start:

```bash
cd /var/home/Ronin/odoo-thailand-sandbox
podman compose up -d
```

Stop:

```bash
cd /var/home/Ronin/odoo-thailand-sandbox
podman compose down
```

Logs:

```bash
cd /var/home/Ronin/odoo-thailand-sandbox
podman compose logs -f odoo
```

## Initial database target

When Odoo UI loads, create a fake database:

- Database: `thai_roofing_sandbox`
- Country: Thailand
- Data: fake only

Installed/test-visible modules in `TestDatabase` as of 2026-06-14:

- Discuss
- Calendar
- To-do
- Contacts
- CRM
- Sales
- Dashboards
- Point of Sale
- Invoicing
- Project
- Purchase
- Inventory
- Manufacturing
- Maintenance
- Repairs
- Employees
- Attendances
- Fleet
- Expenses
- Thailand accounting localization (`l10n_th`)

CE apps that are still installable but not installed yet include Website/eCommerce, Live Chat, Recruitment, Time Off, Email Marketing, Surveys, Lunch, and others.

Enterprise/locked placeholders observed as uninstallable in CE include Studio, full Accounting app shell (`accountant`), Barcode, Helpdesk, Field Service, Planning, Quality, VoIP, Sign, Subscriptions, Appointments, Knowledge, and several advanced manufacturing/planning modules.

Next test path:

- Refresh/reload the browser after module install; the top-level menu should now include CRM, Point of Sale, Manufacturing, Maintenance, Repairs, Fleet, Expenses, and Attendances.
- Ignore or later clean the sandbox-only top-level `Tests` menu if it came from demo/test data.
- Exercise fake workflows: cash POS sale, credit sale, purchase receipt, stock adjustment, invoice/tax invoice, payment, expense approval, manufacturing/BOM case, repair case, and fleet/maintenance logs.
- Add OCA Thailand modules after base app behavior is understood.
