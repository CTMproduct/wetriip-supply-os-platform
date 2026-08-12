import { extractDateRange, extractMarkets, extractPercent, parseIntent } from './intent-grammar';

const ctx = { now: new Date('2026-08-11T12:00:00Z'), propertyId: 'p1' };

describe('Deterministic intent grammar', () => {
  it('parses the reference voice command from the architecture', () => {
    const r = parseIntent(
      'Crea una promoción para reservas hechas con mínimo 30 días de anticipación, 10% de descuento, para septiembre, solamente México.',
      ctx,
    );
    expect(r.matched).toBe(true);
    const cmd: any = r.command;
    expect(cmd.kind).toBe('create_promotion');
    expect(cmd.definition.type).toBe('EARLY_BOOKING');
    expect(cmd.definition.bookingWindow.minAdvanceDays).toBe(30);
    expect(cmd.definition.discount.value).toBe(10);
    expect(cmd.definition.stayWindow).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(cmd.definition.audience.markets).toEqual(['MX']);
  });

  it('understands the same request in English', () => {
    const r = parseIntent('create a 10% discount for stays in september for mexico', ctx);
    expect(r.matched).toBe(true);
    expect((r.command as any).definition.audience.markets).toEqual(['MX']);
  });

  it('turns a decrease into a negative percentage', () => {
    const r = parseIntent('baja mis tarifas 8% para septiembre', ctx);
    expect(r.matched).toBe(true);
    expect((r.command as any).changeType).toBe('PERCENTAGE');
    expect((r.command as any).value).toBe(-8);
  });

  it('uses the screen context instead of asking again', () => {
    const r = parseIntent('pon 3 noches mínimo aquí', {
      ...ctx,
      roomTypeCode: 'DLX',
      ratePlanCode: 'BAR',
      selectedDates: ['2026-09-20', '2026-09-21', '2026-09-22'],
    });
    expect(r.matched).toBe(true);
    const cmd: any = r.command;
    expect(cmd.kind).toBe('update_restriction');
    expect(cmd.restriction.minLos).toBe(3);
    expect(cmd.target.from).toBe('2026-09-20');
    expect(cmd.target.roomTypeCodes).toEqual(['DLX']);
  });

  it('refuses to guess a date range and says what is missing', () => {
    const r = parseIntent('sube mis tarifas 10%', ctx);
    expect(r.matched).toBe(false);
    expect(r.missing).toContain('dateRange');
    expect(r.reason).toMatch(/which dates/i);
  });

  it('refuses to guess a discount', () => {
    const r = parseIntent('crea una promoción para septiembre', ctx);
    expect(r.matched).toBe(false);
    expect(r.missing).toContain('discount');
  });

  it('refuses to act without a property', () => {
    const r = parseIntent('¿por qué no estoy vendiendo?', { now: ctx.now });
    expect(r.matched).toBe(false);
    expect(r.missing).toContain('propertyId');
  });

  it('says plainly when a request is outside what it may do', () => {
    const r = parseIntent('transfiere 5000 dólares a la cuenta del hotel', ctx);
    expect(r.matched).toBe(false);
    expect(r.intent).toBe('unknown');
    expect(r.reason).toMatch(/could not turn that into an action/i);
  });

  it('parses the diagnostic question', () => {
    const r = parseIntent('¿Por qué no estoy vendiendo?', ctx);
    expect(r.matched).toBe(true);
    expect((r.command as any).kind).toBe('explain_no_sales');
  });
});

describe('grammar helpers', () => {
  it('extracts explicit day ranges', () => {
    expect(extractDateRange('del 1 al 30 de septiembre', ctx.now)).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
      label: '1-30 septiembre',
    });
  });

  it('extracts whole months and rolls to next year when the month has passed', () => {
    const r = extractDateRange('en marzo', new Date('2026-08-11T00:00:00Z'));
    expect(r?.from).toBe('2027-03-01');
  });

  it('returns null rather than guessing for a movable feast', () => {
    expect(extractDateRange('semana santa', ctx.now)).toBeNull();
  });

  it('extracts percentages and markets', () => {
    expect(extractPercent('10% de descuento')).toBe(10);
    expect(extractMarkets('solamente México y Colombia').sort()).toEqual(['CO', 'MX']);
  });
});

describe('early booking phrasing', () => {
  it('reads the advance window from "early booking N días" without "de anticipación"', () => {
    const r = parseIntent(
      'Crea una promoción early booking 45 días, 12% de descuento para octubre, solo México',
      ctx,
    );
    expect(r.matched).toBe(true);
    const cmd: any = r.command;
    expect(cmd.definition.type).toBe('EARLY_BOOKING');
    expect(cmd.definition.bookingWindow.minAdvanceDays).toBe(45);
    expect(cmd.definition.discount.value).toBe(12);
    expect(cmd.definition.audience.markets).toEqual(['MX']);
  });

  it('still reads the explicit Spanish phrasing', () => {
    const r = parseIntent(
      'crea una promoción con mínimo 30 días de anticipación, 10% para septiembre',
      ctx,
    );
    expect((r.command as any).definition.bookingWindow.minAdvanceDays).toBe(30);
  });

  it('does not invent an advance window when none was mentioned', () => {
    const r = parseIntent('crea una promoción de 10% para septiembre', ctx);
    expect(r.matched).toBe(true);
    expect((r.command as any).definition.type).toBe('PERCENTAGE');
    expect((r.command as any).definition.bookingWindow.minAdvanceDays).toBeUndefined();
  });
});

describe('Groups and event space', () => {
  it('parses the gratuidad rule that every hotel in the region asks for', () => {
    const r = parseIntent('Doy una gratuidad por cada 20 habitaciones', ctx);
    expect(r.matched).toBe(true);
    const cmd: any = r.command;
    expect(cmd.kind).toBe('set_group_policy');
    expect(cmd.benefits[0]).toMatchObject({
      kind: 'COMP_ROOM',
      everyNRooms: 20,
      basis: 'PER_STAY',
    });
  });

  it('reads the comp rule in the other word order', () => {
    const r = parseIntent('por cada 15 habitaciones una gratuidad', ctx);
    expect((r.command as any).benefits[0].everyNRooms).toBe(15);
  });

  it('distinguishes a per-night entitlement from a per-stay one', () => {
    const r = parseIntent('una gratuidad por cada 20 habitaciones por noche', ctx);
    expect((r.command as any).benefits[0].basis).toBe('PER_NIGHT');
  });

  it('honours a stated cap', () => {
    const r = parseIntent('una gratuidad cada 10 habitaciones, maximo 3', ctx);
    expect((r.command as any).benefits[0].maxUnits).toBe(3);
  });

  it('parses a group floor rate with its currency', () => {
    const r = parseIntent('la tarifa piso de grupos es 320000 COP', ctx);
    const cmd: any = r.command;
    expect(cmd.kind).toBe('set_group_policy');
    expect(cmd.floorRatePerNight).toBe(320000);
    expect(cmd.floorCurrency).toBe('COP');
  });

  it('parses the response window a hotel wants for group offers', () => {
    const r = parseIntent('las agencias tienen 48 horas para responder', ctx);
    expect((r.command as any).responseWindowHours).toBe(48);
  });

  it('lists group requests, filtered by state when one is named', () => {
    const open = parseIntent('muestrame las solicitudes de grupo pendientes', ctx);
    expect((open.command as any).kind).toBe('list_group_requests');
    expect((open.command as any).status).toBe('OPEN');
  });

  it('reads the event spaces without confusing that with configuring one', () => {
    const r = parseIntent('cuales son mis salones', ctx);
    expect((r.command as any).kind).toBe('get_event_spaces');
  });

  it('refuses to guess which group to accept when none is named', () => {
    const r = parseIntent('acepta el grupo', ctx);
    expect(r.matched).toBe(false);
  });

  it('accepts a named group request', () => {
    const r = parseIntent('acepta la solicitud abc123def', ctx);
    const cmd: any = r.command;
    expect(cmd.kind).toBe('respond_group_request');
    expect(cmd.requestId).toBe('abc123def');
    expect(cmd.decision).toBe('ACCEPT');
  });

  it('will not build a counter-offer without the amount', () => {
    const r = parseIntent('contraoferta al grupo abc123def', ctx);
    expect(r.matched).toBe(false);
    expect(r.missing).toEqual(['counterTotal']);
  });

  it('builds a counter-offer when the figure is stated', () => {
    const r = parseIntent('contraoferta al grupo abc123def por 9500', ctx);
    const cmd: any = r.command;
    expect(cmd.decision).toBe('COUNTER');
    expect(cmd.counterTotal).toBe(9500);
  });

  it('needs a property before it will set a group policy', () => {
    const r = parseIntent('una gratuidad por cada 20 habitaciones', { ...ctx, propertyId: null });
    expect(r.matched).toBe(false);
    expect(r.missing).toEqual(['propertyId']);
  });

  it('does not mistake an ordinary rate change for a group rule', () => {
    const r = parseIntent('sube mis tarifas 10% para septiembre', ctx);
    expect((r.command as any).kind).toBe('update_rates');
  });
});
