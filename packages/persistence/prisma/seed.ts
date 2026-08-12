/**
 * Seed.
 *
 * Creates a tenant that is deliberately IMPERFECT: one hotel is not approved,
 * one room type never receives inventory, and weekends carry a closed-to-
 * arrival restriction. A demo where everything is green teaches nobody how the
 * platform behaves when something is wrong, and "why am I not selling?" has
 * nothing to answer.
 *
 * ARI itself is NOT seeded here. It is pulled through the real connectivity
 * pipeline after the server starts (`npm run bootstrap:ari`), so the ledger,
 * the ordering rules and the materializer are all exercised. Inserting
 * inventory straight into the tables would give us data that could never have
 * arrived that way.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('> seeding wetriip supply os');

  const tenant = await prisma.tenant.upsert({
    where: { code: 'ctm' },
    update: {},
    create: { code: 'ctm', name: 'CTM En Linea' },
  });

  const platformOrg = await upsertOrg(tenant.id, {
    code: 'WETRIIP',
    name: 'Wetriip',
    type: 'PLATFORM',
    country: 'CO',
    defaultCurrency: 'USD',
  });

  const hotelOrg = await upsertOrg(tenant.id, {
    code: 'CARIBE-HOTELS',
    name: 'Caribe Hotels Group',
    type: 'CHAIN',
    country: 'CO',
    defaultCurrency: 'COP',
  });

  const agencyOrg = await upsertOrg(tenant.id, {
    code: 'CTM-AGENCY',
    name: 'CTM En Linea (Agency)',
    type: 'AGENCY',
    country: 'CO',
    defaultCurrency: 'COP',
    defaultCommissionPct: 12,
  });

  const mexicoBuyer = await upsertOrg(tenant.id, {
    code: 'MX-WHOLESALE',
    name: 'Mayorista MX',
    type: 'WHOLESALER',
    country: 'MX',
    defaultCurrency: 'MXN',
    defaultCommissionPct: 15,
  });

  // ── Users ──────────────────────────────────────────────
  // maxAutonomy is per user and caps what the agent may do on their behalf.
  // The role decides WHAT may be asked for; maxAutonomy decides how far the
  // agent may go without a human confirming. They are independent on purpose.
  await upsertUser(tenant.id, hotelOrg.id, {
    email: 'melisa@caribehotels.co',
    name: 'Melisa Rojas',
    jobTitle: 'Revenue Manager',
    role: 'REVENUE_MANAGER',
    maxAutonomy: 2,
  });
  await upsertUser(tenant.id, hotelOrg.id, {
    email: 'gerencia@caribehotels.co',
    name: 'Claudia Restrepo',
    jobTitle: 'Gerente General',
    role: 'GENERAL_MANAGER',
    maxAutonomy: 3,
  });
  // E-commerce reads everything and may ASK the agent for a rate change, but
  // holds no write permission — the proposal is simulated and then refused at
  // confirmation. That refusal is the product, not a gap.
  await upsertUser(tenant.id, hotelOrg.id, {
    email: 'ecommerce@caribehotels.co',
    name: 'Julián Mesa',
    jobTitle: 'E-commerce & Distribución',
    role: 'ECOMMERCE',
    maxAutonomy: 1,
  });
  await upsertUser(tenant.id, hotelOrg.id, {
    email: 'andres@caribehotels.co',
    name: 'Andres Felipe',
    jobTitle: 'Propietario',
    role: 'HOTEL_OWNER',
    maxAutonomy: 3,
  });
  await upsertUser(tenant.id, hotelOrg.id, {
    email: 'reservas@caribehotels.co',
    name: 'Reservas',
    jobTitle: 'Reservas',
    role: 'RESERVATION_AGENT',
    maxAutonomy: 1,
  });
  // Someone who left. Kept, not deleted: the audit trail must still resolve
  // their name, and a DISABLED account cannot obtain a session.
  await upsertUser(tenant.id, hotelOrg.id, {
    email: 'exrevenue@caribehotels.co',
    name: 'Diego Pardo',
    jobTitle: 'Revenue Manager (inactivo)',
    role: 'REVENUE_MANAGER',
    maxAutonomy: 1,
    status: 'DISABLED',
  });
  await upsertUser(tenant.id, agencyOrg.id, {
    email: 'gerencia@ctmenlinea.com.co',
    name: 'CTM Gerencia',
    role: 'AGENCY_ADMIN',
    maxAutonomy: 2,
  });
  await upsertUser(tenant.id, platformOrg.id, {
    email: 'ops@wetriip.ai',
    name: 'Wetriip Ops',
    role: 'SUPER_ADMIN',
    maxAutonomy: 3,
  });

  // ── Properties ─────────────────────────────────────────
  const cartagena = await upsertProperty(tenant.id, hotelOrg.id, {
    code: 'WT-CTG-001',
    name: 'Hotel Bahia Cartagena',
    city: 'Cartagena',
    country: 'CO',
    currency: 'COP',
    stars: 5,
    status: 'APPROVED',
  });

  const bogota = await upsertProperty(tenant.id, hotelOrg.id, {
    code: 'WT-BOG-002',
    name: 'Hotel Andino Bogota',
    city: 'Bogota',
    country: 'CO',
    currency: 'COP',
    stars: 4,
    status: 'APPROVED',
  });

  // Deliberately left unapproved: the sellability engine must exclude it, and
  // the console must say why rather than showing an empty result.
  const medellin = await upsertProperty(tenant.id, hotelOrg.id, {
    code: 'WT-MDE-003',
    name: 'Hotel Poblado Medellin',
    city: 'Medellin',
    country: 'CO',
    currency: 'COP',
    stars: 4,
    status: 'PENDING_APPROVAL',
  });

  for (const property of [cartagena, bogota, medellin]) {
    await seedCatalog(property.id);
  }

  // ── Connections + published mappings ───────────────────
  for (const property of [cartagena, bogota, medellin]) {
    const connection = await prisma.connection.upsert({
      where: { id: `conn-${property.code}` },
      update: {},
      create: {
        id: `conn-${property.code}`,
        tenantId: tenant.id,
        propertyId: property.id,
        provider: 'MOCK_CM',
        displayName: `Mock Channel Manager (${property.code})`,
        mode: 'BOTH',
        status: 'PENDING',
        credentialsRef: `mock-${property.code.toLowerCase()}`,
        webhookSecret: null,
      },
    });

    const rooms = await prisma.roomType.findMany({ where: { propertyId: property.id } });
    const plans = await prisma.ratePlan.findMany({ where: { propertyId: property.id } });

    const existing = await prisma.mappingVersion.findFirst({
      where: { connectionId: connection.id, version: 1 },
    });
    if (!existing) {
      await prisma.mappingVersion.create({
        data: {
          connectionId: connection.id,
          version: 1,
          status: 'ACTIVE',
          note: 'seeded mapping',
          createdBy: 'seed',
          approvedBy: 'seed',
          publishedAt: new Date(),
          entries: {
            create: [
              ...rooms.map((r) => ({
                entityType: 'ROOM_TYPE' as const,
                remoteCode: r.code,
                remoteName: r.name,
                localRoomTypeId: r.id,
              })),
              ...plans.map((p) => ({
                entityType: 'RATE_PLAN' as const,
                remoteCode: p.code,
                remoteName: p.name,
                localRatePlanId: p.id,
              })),
            ],
          },
        },
      });
    }
  }

  // ── Contracts ──────────────────────────────────────────
  await upsertContract(tenant.id, {
    code: 'CTR-CTM-2026',
    name: 'Caribe Hotels <-> CTM En Linea',
    supplierOrgId: hotelOrg.id,
    buyerOrgId: agencyOrg.id,
    currency: 'COP',
    paymentModel: 'COMMISSION',
    commissionPct: 12,
    markets: ['CO', 'MX', 'US'],
    channels: ['B2B'],
    propertyIds: [],
    status: 'PUBLISHED',
  });

  await upsertContract(tenant.id, {
    code: 'CTR-MX-2026',
    name: 'Caribe Hotels <-> Mayorista MX',
    supplierOrgId: hotelOrg.id,
    buyerOrgId: mexicoBuyer.id,
    currency: 'COP',
    paymentModel: 'NET',
    commissionPct: 0,
    markupPct: 8,
    markets: ['MX'],
    channels: ['B2B'],
    propertyIds: [cartagena.id],
    status: 'PUBLISHED',
  });

  // ── Taxes ──────────────────────────────────────────────
  for (const property of [cartagena, bogota]) {
    await prisma.taxRule.upsert({
      where: { propertyId_code: { propertyId: property.id, code: 'IVA' } },
      update: {},
      create: {
        propertyId: property.id,
        code: 'IVA',
        name: 'IVA 19%',
        mode: 'PERCENTAGE',
        value: 19,
        included: false,
      },
    });
    await prisma.taxRule.upsert({
      where: { propertyId_code: { propertyId: property.id, code: 'RESORT_FEE' } },
      update: {},
      create: {
        propertyId: property.id,
        code: 'RESORT_FEE',
        name: 'Resort fee',
        mode: 'FIXED_PER_NIGHT',
        value: 25000,
        currency: 'COP',
        included: false,
      },
    });
  }

  // ── Content ────────────────────────────────────────────
  // Cartagena is well documented; Bogota is deliberately thin so the
  // completeness score and the "what is missing" path have something real to
  // report. Medellin has nothing at all.
  await upsertContent(tenant.id, cartagena.id, {
    descriptionShort: 'Hotel frente al mar en el centro historico de Cartagena.',
    descriptionLong:
      'A cinco minutos de la Ciudad Amurallada, con 53 habitaciones, piscina en terraza y acceso directo a playa. Salones para eventos corporativos de hasta 120 personas.',
    highlights: ['Frente al mar', 'Ciudad Amurallada a 5 minutos', 'Salones para eventos'],
    addressLine1: 'Carrera 1 # 12-34, Bocagrande',
    postalCode: '130001',
    latitude: 10.3997,
    longitude: -75.5514,
    phone: '+57 5 655 0000',
    email: 'reservas@caribehotels.co',
    checkInFrom: '15:00',
    checkOutBy: '12:00',
    amenities: [
      'WIFI_FREE', 'POOL', 'BEACH_ACCESS', 'RESTAURANT', 'BAR', 'AIR_CONDITIONING',
      'MEETING_ROOMS', 'AIRPORT_SHUTTLE', 'SAFE', 'ELEVATOR', 'CONCIERGE', 'TERRACE',
    ],
    policies: {
      pets: 'No se admiten mascotas.',
      children: 'Menores de 5 anos sin costo compartiendo habitacion.',
      smoking: 'Propiedad libre de humo.',
    },
  });

  await upsertContent(tenant.id, bogota.id, {
    descriptionShort: 'Hotel de negocios en el norte de Bogota.',
    addressLine1: 'Calle 93 # 15-20',
    amenities: ['WIFI_FREE', 'GYM', 'RESTAURANT', 'BUSINESS_CENTER'],
  });

  for (const [i, url] of [
    'https://images.wetriip.dev/ctg/exterior-1.jpg',
    'https://images.wetriip.dev/ctg/pool-1.jpg',
    'https://images.wetriip.dev/ctg/room-deluxe-1.jpg',
    'https://images.wetriip.dev/ctg/room-suite-1.jpg',
    'https://images.wetriip.dev/ctg/restaurant-1.jpg',
    'https://images.wetriip.dev/ctg/beach-1.jpg',
  ].entries()) {
    const category = ['EXTERIOR', 'POOL', 'ROOM', 'ROOM', 'RESTAURANT', 'BEACH'][i] as any;
    const existing = await prisma.propertyImage.findFirst({ where: { propertyId: cartagena.id, url } });
    if (existing) continue;
    await prisma.propertyImage.create({
      data: {
        tenantId: tenant.id,
        propertyId: cartagena.id,
        layer: 'MANAGED',
        source: 'MANUAL',
        url,
        category,
        position: i,
        isHero: i === 0,
        caption: null,
      },
    });
  }

  // ── Distribution policies ──────────────────────────────
  // Cartagena is open to the marketplace but closed to one market, so the
  // eligibility engine has a real rule to enforce. Bogota is partner-exclusive.
  await upsertDistribution(tenant.id, cartagena.id, {
    mode: 'MARKETPLACE_OPEN',
    allowedMarkets: [],
    blockedMarkets: ['VE'],
    allowedPartnerIds: [],
    blockedPartnerIds: [],
    allowedPartnerTypes: ['WHOLESALER', 'AGENCY', 'OTA'],
    allowedChannels: ['B2B'],
    minAdvanceDays: 1,
    requiresApproval: false,
    note: 'Abierto al marketplace B2B, excepto Venezuela.',
  });

  await upsertDistribution(tenant.id, bogota.id, {
    mode: 'SELECTED_PARTNERS',
    allowedMarkets: [],
    blockedMarkets: [],
    allowedPartnerIds: [agencyOrg.id],
    blockedPartnerIds: [],
    allowedPartnerTypes: [],
    allowedChannels: ['B2B'],
    requiresApproval: false,
    note: 'Exclusivo para CTM En Linea mientras se estabiliza la conectividad.',
  });

  // ── Partner profiles ───────────────────────────────────
  await upsertPartner(tenant.id, {
    organizationId: agencyOrg.id,
    partnerCode: 'CTM-001',
    status: 'ACTIVE',
    legalName: 'Consolidators & Tourist Management S.A.S.',
    taxIdScheme: 'NIT',
    taxId: '900123456-7',
    taxCountry: 'CO',
    billingEmail: 'facturacion@ctmenlinea.com.co',
    billingCity: 'Bogota',
    billingCountry: 'CO',
    contactName: 'Gerencia CTM',
    sourceMarkets: ['CO'],
    paymentTerms: 'NET_30',
    currency: 'COP',
    creditLimit: 120000000,
    creditWarningPct: 80,
  });

  await upsertPartner(tenant.id, {
    organizationId: mexicoBuyer.id,
    partnerCode: 'MX-WHL-002',
    status: 'ACTIVE',
    legalName: 'Mayorista MX S.A. de C.V.',
    taxIdScheme: 'RFC',
    taxId: 'MMX980101AB1',
    taxCountry: 'MX',
    billingEmail: 'cuentas@mayoristamx.mx',
    billingCity: 'Ciudad de Mexico',
    billingCountry: 'MX',
    sourceMarkets: ['MX'],
    paymentTerms: 'NET_15',
    currency: 'USD',
    creditLimit: 50000,
    creditWarningPct: 75,
  });

  // ── Groups: block, policy, and one live negotiation ────
  // A block whose bedding lines deliberately sum above the ceiling: the same
  // twenty rooms can be made up twin OR double, and the platform has to hold
  // both truths at once without overselling either.
  const rooms = await prisma.roomType.findMany({ where: { propertyId: cartagena.id } });
  const dlx = rooms.find((r) => r.code === 'DLX') ?? rooms[0];

  const block = await prisma.groupBlock.upsert({
    where: { tenantId_propertyId_code: { tenantId: tenant.id, propertyId: cartagena.id, code: 'GRP-SEP' } },
    update: { status: 'OPEN', roomsCeiling: 20 },
    create: {
      tenantId: tenant.id,
      propertyId: cartagena.id,
      code: 'GRP-SEP',
      name: 'Bloqueo grupos septiembre',
      fromDate: addDaysIso(25),
      toDate: addDaysIso(55),
      currency: 'COP',
      roomsCeiling: 20,
      releaseDays: 21,
      minRooms: 10,
      status: 'OPEN',
      createdBy: 'seed',
    },
  });

  await prisma.groupBlockLine.deleteMany({ where: { blockId: block.id } });
  await prisma.groupBlockLine.createMany({
    data: [
      { blockId: block.id, roomTypeId: dlx.id, bedding: 'TWIN', roomsTotal: 18, ratePerNight: 420000 },
      { blockId: block.id, roomTypeId: dlx.id, bedding: 'DOUBLE', roomsTotal: 20, ratePerNight: 420000 },
      { blockId: block.id, roomTypeId: dlx.id, bedding: 'TRIPLE', roomsTotal: 6, ratePerNight: 520000 },
    ],
  });

  await prisma.groupPolicy.upsert({
    where: { propertyId: cartagena.id },
    update: {},
    create: {
      tenantId: tenant.id,
      propertyId: cartagena.id,
      minRoomsForGroup: 10,
      floorRatePerNight: 380000,
      floorCurrency: 'COP',
      autoDeclineBelowFloor: false,
      responseWindowHours: 24,
      depositPct: 30,
      cancellationPolicy: 'Penalidad del 50% dentro de los 15 días previos a la llegada.',
      // The term every hotel in the region quotes, and the one whose true cost
      // most of them underestimate.
      benefits: [
        { kind: 'COMP_ROOM', everyNRooms: 20, maxUnits: null, basis: 'PER_STAY', description: 'Una gratuidad por cada 20 habitaciones pagadas' },
        { kind: 'TOUR_LEADER_FREE', everyNRooms: 25, maxUnits: 1, basis: 'PER_STAY', description: null },
      ] as any,
      notifyEmails: ['grupos@caribehotels.co'],
      notifyWhatsapp: ['+573001234567'],
      updatedBy: 'seed',
    },
  });

  // ── Event spaces ───────────────────────────────────────
  await prisma.eventSpace.upsert({
    where: { tenantId_propertyId_code: { tenantId: tenant.id, propertyId: cartagena.id, code: 'SALON-BAHIA' } },
    update: {},
    create: {
      tenantId: tenant.id,
      propertyId: cartagena.id,
      code: 'SALON-BAHIA',
      name: 'Salón Bahía',
      currency: 'COP',
      areaM2: 180,
      ceilingHeightM: 3.4,
      naturalLight: true,
      divisible: true,
      floor: 'Nivel 2',
      halfDayHours: 4,
      fullDayHours: 8,
      layouts: [
        { layout: 'THEATRE', capacity: 120, setupFee: 0 },
        { layout: 'CLASSROOM', capacity: 60, setupFee: 0 },
        { layout: 'U_SHAPE', capacity: 28, setupFee: 150000 },
        { layout: 'BANQUET', capacity: 80, setupFee: 300000 },
        { layout: 'COCKTAIL', capacity: 150, setupFee: 120000 },
      ] as any,
      rates: [
        { unit: 'HOUR', amount: 250000, minimumPax: 0 },
        { unit: 'HALF_DAY', amount: 800000, minimumPax: 0 },
        { unit: 'FULL_DAY', amount: 1400000, minimumPax: 0 },
      ] as any,
      addons: [
        { kind: 'MICROPHONE', name: 'Micrófono alámbrico', unit: 'PER_EVENT', amount: 0, includedInSpace: true, description: null },
        { kind: 'WIRELESS_MICROPHONE', name: 'Micrófono inalámbrico', unit: 'PER_EVENT', amount: 90000, includedInSpace: false, description: null },
        { kind: 'VIDEOBEAM', name: 'Videobeam', unit: 'PER_DAY', amount: 180000, includedInSpace: false, description: null },
        { kind: 'SCREEN', name: 'Pantalla', unit: 'PER_DAY', amount: 60000, includedInSpace: false, description: null },
        { kind: 'SOUND_SYSTEM', name: 'Sonido', unit: 'PER_DAY', amount: 220000, includedInSpace: false, description: null },
        { kind: 'WIFI_DEDICATED', name: 'WiFi dedicado', unit: 'PER_DAY', amount: 150000, includedInSpace: false, description: null },
        { kind: 'COFFEE_BREAK', name: 'Coffee break', unit: 'PER_PERSON', amount: 22000, includedInSpace: false, description: 'Café, aromáticas y bocado dulce' },
        { kind: 'COFFEE_BREAK_PREMIUM', name: 'Coffee break premium', unit: 'PER_PERSON', amount: 38000, includedInSpace: false, description: null },
        { kind: 'LUNCH', name: 'Almuerzo', unit: 'PER_PERSON', amount: 65000, includedInSpace: false, description: null },
      ] as any,
      active: true,
      updatedBy: 'seed',
    },
  });

  await prisma.eventSpace.upsert({
    where: { tenantId_propertyId_code: { tenantId: tenant.id, propertyId: cartagena.id, code: 'BOARD-CORAL' } },
    update: {},
    create: {
      tenantId: tenant.id,
      propertyId: cartagena.id,
      code: 'BOARD-CORAL',
      name: 'Sala Coral',
      currency: 'COP',
      areaM2: 42,
      ceilingHeightM: 2.8,
      naturalLight: false,
      divisible: false,
      floor: 'Nivel 1',
      halfDayHours: 4,
      fullDayHours: 8,
      layouts: [
        { layout: 'BOARDROOM', capacity: 14, setupFee: 0 },
        { layout: 'U_SHAPE', capacity: 12, setupFee: 0 },
      ] as any,
      rates: [
        { unit: 'HOUR', amount: 120000, minimumPax: 0 },
        { unit: 'FULL_DAY', amount: 700000, minimumPax: 0 },
      ] as any,
      addons: [
        { kind: 'VIDEOBEAM', name: 'Videobeam', unit: 'PER_DAY', amount: 180000, includedInSpace: false, description: null },
        { kind: 'COFFEE_BREAK', name: 'Coffee break', unit: 'PER_PERSON', amount: 22000, includedInSpace: false, description: null },
      ] as any,
      active: true,
      updatedBy: 'seed',
    },
  });

  console.log(`> seeded tenant ${tenant.code}`);
  console.log('> sign in with melisa@caribehotels.co (Revenue Manager, autonomy 2)');
  console.log('> next: start the server, then run  npm run bootstrap:ari');
}

/** Seed dates are relative so the demo data never goes stale on the shelf. */
function addDaysIso(n: number): string {
  return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
}

async function upsertContent(tenantId: string, propertyId: string, values: any) {
  return prisma.propertyContent.upsert({
    where: { propertyId_layer_locale: { propertyId, layer: 'MANAGED', locale: 'es' } },
    update: {},
    create: {
      tenantId,
      propertyId,
      layer: 'MANAGED',
      source: 'MANUAL',
      locale: 'es',
      highlights: values.highlights ?? [],
      amenities: values.amenities ?? [],
      ...values,
      updatedBy: 'seed',
    },
  });
}

async function upsertDistribution(tenantId: string, propertyId: string, policy: any) {
  return prisma.distributionPolicy.upsert({
    where: { propertyId },
    update: {},
    create: { tenantId, propertyId, ...policy, updatedBy: 'seed' },
  });
}

async function upsertPartner(tenantId: string, data: any) {
  return prisma.partnerProfile.upsert({
    where: { organizationId: data.organizationId },
    update: {},
    create: { tenantId, ...data, onboardedAt: new Date() },
  });
}

async function upsertOrg(tenantId: string, data: any) {
  return prisma.organization.upsert({
    where: { tenantId_code: { tenantId, code: data.code } },
    update: {},
    create: { tenantId, ...data },
  });
}

async function upsertUser(tenantId: string, organizationId: string, data: any) {
  const shape = {
    role: data.role,
    maxAutonomy: data.maxAutonomy,
    jobTitle: data.jobTitle ?? null,
    status: data.status ?? 'ACTIVE',
    grants: data.grants ?? [],
    revokes: data.revokes ?? [],
    propertyIds: data.propertyIds ?? [],
    disabledAt: data.status === 'DISABLED' ? new Date() : null,
    disabledBy: data.status === 'DISABLED' ? 'seed' : null,
  };
  return prisma.user.upsert({
    where: { tenantId_email: { tenantId, email: data.email } },
    // The seed is re-runnable, so it must restore the intended shape rather
    // than leave whatever a previous demo left behind.
    update: shape,
    create: { tenantId, organizationId, email: data.email, name: data.name, ...shape },
  });
}

async function upsertProperty(tenantId: string, organizationId: string, data: any) {
  return prisma.property.upsert({
    where: { tenantId_code: { tenantId, code: data.code } },
    update: { status: data.status },
    create: {
      tenantId,
      organizationId,
      ...data,
      approvedAt: data.status === 'APPROVED' ? new Date() : null,
      approvedBy: data.status === 'APPROVED' ? 'seed' : null,
    },
  });
}

async function seedCatalog(propertyId: string) {
  const rooms = [
    { code: 'DLX', name: 'Deluxe King', maxOccupancy: 2, maxAdults: 2, quantity: 20 },
    { code: 'JSU', name: 'Junior Suite', maxOccupancy: 3, maxAdults: 3, quantity: 8 },
    { code: 'STD', name: 'Standard Twin', maxOccupancy: 2, maxAdults: 2, quantity: 25 },
  ];
  for (const r of rooms) {
    await prisma.roomType.upsert({
      where: { propertyId_code: { propertyId, code: r.code } },
      update: {},
      create: { propertyId, ...r },
    });
  }

  const plans = [
    { code: 'BAR', name: 'Best Available Rate', mealPlan: 'RO', refundable: true },
    { code: 'BARBB', name: 'BAR Bed & Breakfast', mealPlan: 'BB', refundable: true },
    { code: 'NREF', name: 'Non Refundable', mealPlan: 'RO', refundable: false },
  ];
  for (const p of plans) {
    await prisma.ratePlan.upsert({
      where: { propertyId_code: { propertyId, code: p.code } },
      update: {},
      create: { propertyId, currency: 'COP', source: 'EXTERNAL', ...p },
    });
  }
}

async function upsertContract(tenantId: string, data: any) {
  const existing = await prisma.contract.findFirst({ where: { tenantId, code: data.code } });
  if (existing) return existing;
  const created = await prisma.contract.create({
    data: {
      tenantId,
      ...data,
      version: 1,
      validFrom: new Date('2026-01-01'),
      validTo: new Date('2027-12-31'),
      cancellationPolicy: {
        freeUntilDays: 3,
        penaltyType: 'FIRST_NIGHT',
        penaltyValue: 0,
        nonRefundable: false,
      },
      promotionPermissions: { canCreate: true, canStack: false, maxDiscountPct: 25 },
      distributionPermissions: { canResell: false, allowedChannels: ['B2B'], blockedMarkets: [] },
      maxResaleDepth: 2,
      publishedAt: data.status === 'PUBLISHED' ? new Date() : null,
      publishedBy: 'seed',
    },
  });
  await prisma.contractVersion.create({
    data: { contractId: created.id, version: 1, snapshot: data as any, createdBy: 'seed' },
  });
  return created;
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
