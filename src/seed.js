require('dotenv').config();
const bcrypt = require('bcrypt');
const db = require('./db');

function seedAdmin() {
  const existing = db.prepare('SELECT id FROM admins LIMIT 1').get();
  if (existing) {
    console.log('Admin already exists, skipping.');
    return;
  }
  const username = process.env.SEED_ADMIN_USER || 'admin';
  const password = process.env.SEED_ADMIN_PASS || 'changeme123';
  const hash = bcrypt.hashSync(password, 12);
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, hash);
  console.log(`Admin created — username: ${username}  password: ${password}`);
  console.log('Log in and change this password path is not built yet — for now, edit the DB directly if you need to rotate it.');
}

// Package catalogue. Editing this list and re-running `node src/seed.js`
// reconciles the live DB: prices/names are updated in place (matched by
// duration_hours), missing tiers are inserted, and nothing is ever deleted.
const PACKAGES = [
  { name: '3 Hour', price: 10, duration_hours: 3 },
  { name: '6 Hours', price: 20, duration_hours: 6 },
  { name: '24 Hours', price: 30, duration_hours: 24 },
  { name: '7 Days', price: 150, duration_hours: 24 * 7 },
  { name: '30 Days', price: 580, duration_hours: 24 * 30 },
];

function seedPackages() {
  const existing = db.prepare('SELECT * FROM packages').all();
  if (existing.length === 0) {
    const insert = db.prepare('INSERT INTO packages (name, price, duration_hours) VALUES (@name, @price, @duration_hours)');
    db.transaction((rows) => rows.forEach((r) => insert.run(r)))(PACKAGES);
    console.log(`Seeded ${PACKAGES.length} packages.`);
    return;
  }

  const update = db.prepare('UPDATE packages SET name = ?, price = ? WHERE id = ?');
  const insert = db.prepare('INSERT INTO packages (name, price, duration_hours) VALUES (@name, @price, @duration_hours)');
  const byDuration = new Map(existing.map((p) => [Number(p.duration_hours), p]));
  let updated = 0;
  let inserted = 0;
  const run = db.transaction(() => {
    for (const pkg of PACKAGES) {
      const match = byDuration.get(pkg.duration_hours);
      if (match) {
        if (match.name !== pkg.name || Number(match.price) !== pkg.price) {
          update.run(pkg.name, pkg.price, match.id);
          console.log(`Updated package #${match.id}: ${match.name}(KES ${match.price}) -> ${pkg.name}(KES ${pkg.price})`);
          updated++;
        }
      } else {
        insert.run(pkg);
        console.log(`Inserted new package: ${pkg.name} (KES ${pkg.price})`);
        inserted++;
      }
    }
  });
  run();
  if (updated === 0 && inserted === 0) console.log('Packages already in sync with the catalogue.');
  else console.log(`Package reconciliation done: ${updated} updated, ${inserted} inserted.`);
}

seedAdmin();
seedPackages();
