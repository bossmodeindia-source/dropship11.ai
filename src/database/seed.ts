/**
 * Database seed script.
 * Creates: 1 superadmin, 1 admin, 2 regular users, subscriptions, sample products.
 *
 * Usage:
 *   npm run db:seed
 *   DATABASE_URL=postgres://... ts-node src/database/seed.ts
 */
import 'reflect-metadata';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as argon2 from 'argon2';
import * as schema from '../common/database/schema';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://dropship:dropship@localhost:5432/dropship';

const ARGON2_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 4096, // lower for seed speed — real accounts use 65536
  timeCost: 1,
  parallelism: 1,
};

async function seed(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const db   = drizzle(pool, { schema });

  console.log('🌱 Starting database seed...');

  // ── Users ──────────────────────────────────────────────────────
  const users = [
    {
      email:       'superadmin@dropship.local',
      password:    'SuperAdmin1!',
      role:        'superadmin' as const,
      fullName:    'Super Admin',
      companyName: 'Dropship SaaS',
    },
    {
      email:       'admin@dropship.local',
      password:    'AdminPass1!',
      role:        'admin' as const,
      fullName:    'Platform Admin',
      companyName: 'Dropship SaaS',
    },
    {
      email:       'seller1@dropship.local',
      password:    'Seller1Pass!',
      role:        'user' as const,
      fullName:    'Alice Seller',
      companyName: 'Alice\'s Shop',
      aiMode:      'BOT' as const,
    },
    {
      email:       'seller2@dropship.local',
      password:    'Seller2Pass!',
      role:        'user' as const,
      fullName:    'Bob Merchant',
      companyName: 'Bob\'s Emporium',
      aiMode:      'AI' as const,
    },
  ];

  const insertedUsers: (typeof schema.users.$inferSelect)[] = [];

  for (const u of users) {
    // Upsert: skip if already exists
    const existing = await db.query.users.findFirst({
      where: (t, { eq }) => eq(t.email, u.email),
    });

    if (existing) {
      console.log(`  ↳ User already exists: ${u.email}`);
      insertedUsers.push(existing);
      continue;
    }

    const passwordHash = await argon2.hash(u.password, { ...ARGON2_OPTS, raw: false });
    const [inserted] = await db.insert(schema.users).values({
      email:       u.email,
      passwordHash,
      role:        u.role,
      fullName:    u.fullName,
      companyName: u.companyName,
      aiMode:      u.aiMode ?? 'BOT',
      isVerified:  true,
    }).returning();

    console.log(`  ✅ Created user: ${u.email} (${u.role})`);
    insertedUsers.push(inserted);
  }

  // ── Subscriptions ──────────────────────────────────────────────
  const tierMap: Record<string, typeof schema.subscriptions.$inferInsert['tier']> = {
    'superadmin@dropship.local': 'enterprise',
    'admin@dropship.local':      'enterprise',
    'seller1@dropship.local':    'pro',
    'seller2@dropship.local':    'starter',
  };

  const limitsMap: Record<string, { productLimit: number; orderLimit: number; aiRequestsLimit: number }> = {
    'enterprise': { productLimit: 999999, orderLimit: 999999, aiRequestsLimit: 10000 },
    'pro':        { productLimit: 500,    orderLimit: 5000,   aiRequestsLimit: 500 },
    'starter':    { productLimit: 50,     orderLimit: 500,    aiRequestsLimit: 50 },
  };

  for (const user of insertedUsers) {
    const existingSub = await db.query.subscriptions.findFirst({
      where: (t, { eq }) => eq(t.userId, user.id),
    });
    if (existingSub) continue;

    const tier = tierMap[user.email] ?? 'free';
    const limits = limitsMap[tier] ?? { productLimit: 10, orderLimit: 50, aiRequestsLimit: 0 };

    await db.insert(schema.subscriptions).values({
      userId:           user.id,
      tier,
      status:           'active',
      ...limits,
    });
    console.log(`  ✅ Created ${tier} subscription for: ${user.email}`);
  }

  // ── Sample Products (for seller1) ─────────────────────────────
  const seller1 = insertedUsers.find(u => u.email === 'seller1@dropship.local');
  if (seller1) {
    const existingProducts = await db.query.products.findMany({
      where: (t, { eq }) => eq(t.userId, seller1.id),
    });

    if (existingProducts.length === 0) {
      const sampleProducts = [
        {
          title:         'Wireless Bluetooth Earbuds Pro',
          description:   'High-quality earbuds with noise cancellation and 30hr battery life.',
          supplierPrice: '12.50',
          sellingPrice:  '49.99',
          category:      'Electronics',
          tags:          ['audio', 'wireless', 'bluetooth', 'earbuds'],
          demandScore:   '78.50',
          competitionScore: '62.00',
          marginScore:   '82.00',
          trendIndex:    '71.00',
          compositeScore: '74.30',
          decision:      'TEST_ADS' as const,
          status:        'scored' as const,
        },
        {
          title:         'Portable Phone Stand with Cable Organizer',
          description:   'Adjustable aluminum stand, compatible with all devices.',
          supplierPrice: '3.20',
          sellingPrice:  '19.99',
          category:      'Accessories',
          tags:          ['desk', 'phone', 'stand', 'organizer'],
          demandScore:   '65.00',
          competitionScore: '45.00',
          marginScore:   '91.00',
          trendIndex:    '55.00',
          compositeScore: '67.50',
          decision:      'TEST_ADS' as const,
          status:        'scored' as const,
        },
        {
          title:         'Posture Corrector Back Support Belt',
          description:   'Medical-grade posture corrector for office workers.',
          supplierPrice: '8.00',
          sellingPrice:  '34.99',
          category:      'Health',
          tags:          ['posture', 'back', 'health', 'office'],
          demandScore:   '88.00',
          competitionScore: '52.00',
          marginScore:   '86.00',
          trendIndex:    '83.00',
          compositeScore: '79.20',
          decision:      'RUN_ADS' as const,
          status:        'scored' as const,
        },
        {
          title:         'Generic USB-C Cable 3-Pack',
          description:   'Braided USB-C charging cable.',
          supplierPrice: '2.10',
          sellingPrice:  '7.99',
          category:      'Electronics',
          tags:          ['cable', 'usb-c', 'charging'],
          demandScore:   '55.00',
          competitionScore: '18.00',
          marginScore:   '61.00',
          trendIndex:    '40.00',
          compositeScore: '44.80',
          decision:      'REJECT' as const,
          status:        'scored' as const,
        },
      ];

      for (const p of sampleProducts) {
        await db.insert(schema.products).values({ userId: seller1.id, ...p });
        console.log(`  ✅ Created product: ${p.title} → ${p.decision}`);
      }
    } else {
      console.log(`  ↳ Products already seeded for ${seller1.email}`);
    }
  }

  await pool.end();
  console.log('\n✅ Seed complete!\n');
  console.log('Login credentials:');
  console.log('  superadmin@dropship.local / SuperAdmin1!');
  console.log('  admin@dropship.local      / AdminPass1!');
  console.log('  seller1@dropship.local    / Seller1Pass!');
  console.log('  seller2@dropship.local    / Seller2Pass!');
}

seed().catch((err: unknown) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
