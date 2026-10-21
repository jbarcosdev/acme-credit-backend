import { bankConfirm, call, parseArgs, randomUUID, tokens, until, urls, waitUntilReady } from './lib/stack.mjs';

const args = parseArgs();
const only = args.only ? args.only.split(',') : undefined;
const verbose = args.verbose === 'true';

if (!(await waitUntilReady(30_000))) {
  console.error('Los servicios no responden. Levántalos con: pnpm apps:up (o pnpm dev:lending y pnpm dev:collateral)');
  process.exit(2);
}

const network = await tokens.network('2h');
const scheduler = await tokens.scheduler('2h');
const results = [];
let currentScenario = '';

function check(description, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ scenario: currentScenario, description, ok, actual, expected: typeof expected === 'function' ? '(condition)' : expected });
  const mark = ok ? '  ✔' : '  ✘';
  console.log(`${mark} ${description}${ok ? '' : `\n      esperado: ${JSON.stringify(expected)}\n      recibido: ${JSON.stringify(actual)}`}`);
  if (ok && verbose) console.log(`      ${JSON.stringify(actual)}`);
  return ok;
}

async function scenario(name, fn) {
  if (only && !only.some((id) => name.startsWith(`${id}.`))) return;
  currentScenario = name;
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (error) {
    check(`no debe lanzar excepciones (${error.message})`, false, true);
  }
}

const key = () => randomUUID();

async function customer(depositAmount = 100_000, cycleDay = 15) {
  const userId = `agent-${randomUUID().slice(0, 8)}`;
  const user = await tokens.user(userId, '2h');
  const custody = await call(urls.collateral, 'POST', '/custody-accounts', { auth: user, key: key(), body: {} });
  const deposit = await call(urls.collateral, 'POST', `/custody-accounts/${custody.body.id}/deposits`, {
    auth: user,
    key: key(),
    body: { bankId: 'sim-bank', amount: depositAmount },
  });
  await bankConfirm({ reference: deposit.body.reference, amount: depositAmount });
  const card = await call(urls.lending, 'POST', '/cards', {
    auth: user,
    key: key(),
    body: { custodyAccountId: custody.body.id, cycleDay },
  });
  return { userId, user, custodyId: custody.body.id, cardId: card.body.id, depositReference: deposit.body.reference, card };
}

const authorize = (c, body, k = key()) =>
  call(urls.lending, 'POST', `/accounts/${c.cardId}/authorizations`, { auth: network, key: k, body });
const pay = (c, amount, k = key()) => call(urls.lending, 'POST', `/accounts/${c.cardId}/payments`, { auth: c.user, key: k, body: { amount } });
const account = (c) => call(urls.lending, 'GET', `/accounts/${c.cardId}`, { auth: c.user }).then((r) => r.body);
const custodyAccount = (c) => call(urls.collateral, 'GET', `/custody-accounts/${c.custodyId}`, { auth: c.user }).then((r) => r.body);
const runJobs = () => call(urls.lending, 'POST', '/internal/jobs/daily', { auth: scheduler }).then((r) => r.body);
const advanceDays = (days) => call(urls.lending, 'POST', '/internal/dev/clock', { auth: scheduler, body: { days } });

await scenario('1. Apertura: colateral confirmado, cupo y tarjeta activa', async () => {
  const userId = `agent-${randomUUID().slice(0, 8)}`;
  const user = await tokens.user(userId, '2h');
  const custody = await call(urls.collateral, 'POST', '/custody-accounts', { auth: user, key: key(), body: {} });
  check('abrir la cuenta de custodia responde 201', custody.status, 201);
  const deposit = await call(urls.collateral, 'POST', `/custody-accounts/${custody.body.id}/deposits`, {
    auth: user,
    key: key(),
    body: { bankId: 'sim-bank', amount: 100_000 },
  });
  check('el depósito queda PENDING con una referencia', [deposit.status, deposit.body.status, typeof deposit.body.reference], [201, 'PENDING', 'string']);

  const early = await call(urls.lending, 'POST', '/cards', { auth: user, key: key(), body: { custodyAccountId: custody.body.id, cycleDay: 15 } });
  check('sin colateral confirmado no se emite la tarjeta (422 NO_COLLATERAL)', [early.status, early.body.code], [422, 'NO_COLLATERAL']);

  const confirmed = await bankConfirm({ reference: deposit.body.reference, amount: 100_000 });
  check('el webhook firmado confirma el depósito', [confirmed.status, confirmed.body.status], [200, 'CONFIRMED']);
  const held = await call(urls.collateral, 'GET', `/custody-accounts/${custody.body.id}`, { auth: user });
  check('retenido 100000 y cupo 90000 (ratio 90 %)', [held.body.heldAmount, held.body.cupo], [100_000, 90_000]);

  const card = await call(urls.lending, 'POST', '/cards', { auth: user, key: key(), body: { custodyAccountId: custody.body.id, cycleDay: 15 } });
  check('la tarjeta se emite ACTIVE con 90000 disponibles', [card.status, card.body.status, card.body.availableCredit], [201, 'ACTIVE', 90_000]);
  const second = await call(urls.lending, 'POST', '/cards', { auth: user, key: key(), body: { custodyAccountId: custody.body.id, cycleDay: 15 } });
  check('una segunda tarjeta para la misma custodia se rechaza (409)', second.status, 409);
});

await scenario('2. Compras: aprobar, rechazar y no exceder nunca el cupo', async () => {
  const c = await customer();
  const first = await authorize(c, { amount: 60_000, merchant: 'tienda' });
  check('compra de 60000 aprobada (201) y quedan 30000', [first.status, first.body.status, first.body.availableCredit], [201, 'APPROVED', 30_000]);
  const over = await authorize(c, { amount: 30_001 });
  check('compra de 30001 rechazada por INSUFFICIENT_CREDIT (200)', [over.status, over.body.status, over.body.reason], [200, 'DECLINED', 'INSUFFICIENT_CREDIT']);
  const exact = await authorize(c, { amount: 30_000 });
  check('compra de 30000 aprobada y queda en 0', [exact.body.status, exact.body.availableCredit], ['APPROVED', 0]);
  const a = await account(c);
  check('deuda 90000 y disponible 0', [a.balances.debt, a.availableCredit], [90_000, 0]);
});

await scenario('3. Idempotencia: repetir una petición no repite el efecto', async () => {
  const c = await customer();
  const k = key();
  const one = await authorize(c, { amount: 10_000 }, k);
  const again = await authorize(c, { amount: 10_000 }, k);
  check('la misma clave devuelve la misma autorización', again.body.authorizationId, one.body.authorizationId);
  const reused = await authorize(c, { amount: 10_001 }, k);
  check('la misma clave con otro cuerpo se rechaza (422 IDEMPOTENCY_KEY_REUSED)', [reused.status, reused.body.code], [422, 'IDEMPOTENCY_KEY_REUSED']);
  const missing = await call(urls.lending, 'POST', `/accounts/${c.cardId}/authorizations`, { auth: network, body: { amount: 1 } });
  check('sin Idempotency-Key se rechaza (400)', missing.status, 400);
  const a = await account(c);
  check('solo se cobró una vez', a.balances.debt, 10_000);
});

await scenario('4. Concurrencia: 20 compras en paralelo sobre la misma tarjeta', async () => {
  const c = await customer();
  const burst = await Promise.all(Array.from({ length: 20 }, () => authorize(c, { amount: 5_000 })));
  const approved = burst.filter((r) => r.body.status === 'APPROVED').length;
  check('exactamente 18 aprobadas (90000 / 5000)', approved, 18);
  const a = await account(c);
  check('deuda 90000, nunca por encima del cupo', [a.balances.debt, a.availableCredit], [90_000, 0]);
});

await scenario('5. Seguridad: autenticación, propiedad y webhooks falsificados', async () => {
  const c = await customer();
  const other = await tokens.user('otro-cliente', '2h');
  check('sin token: 401', (await call(urls.lending, 'GET', `/accounts/${c.cardId}`)).status, 401);
  check('token de otro cliente: 404', (await call(urls.lending, 'GET', `/accounts/${c.cardId}`, { auth: other })).status, 404);
  check('un cliente no puede autorizar compras (403)', (await call(urls.lending, 'POST', `/accounts/${c.cardId}/authorizations`, { auth: c.user, key: key(), body: { amount: 1 } })).status, 403);
  check('un cliente no puede liquidar colateral (403)', (await call(urls.collateral, 'POST', `/custody-accounts/${c.custodyId}/settlements`, { auth: c.user, key: key(), body: { applyAmount: 0 } })).status, 403);

  const deposit = await call(urls.collateral, 'POST', `/custody-accounts/${c.custodyId}/deposits`, { auth: c.user, key: key(), body: { bankId: 'sim-bank', amount: 5_000 } });
  const forged = await bankConfirm({ reference: deposit.body.reference, amount: 5_000, forged: true });
  check('webhook con firma falsa: 401', forged.status, 401);
  const unsigned = await call(urls.collateral, 'POST', '/webhooks/banks/sim-bank', { body: { reference: deposit.body.reference } });
  check('webhook sin firma: 401', unsigned.status, 401);
  const mismatch = await bankConfirm({ reference: deposit.body.reference, amount: 4_999 });
  check('webhook con monto distinto: 422', mismatch.status, 422);
  const stranger = await call(urls.collateral, 'GET', `/custody-accounts/${c.custodyId}`, { auth: other });
  check('la custodia de otro cliente también es 404', stranger.status, 404);
  const held = await custodyAccount(c);
  check('nada de lo anterior acreditó dinero', held.heldAmount, 100_000);
  const hmacDeposit = await call(urls.collateral, 'POST', `/custody-accounts/${c.custodyId}/deposits`, { auth: c.user, key: key(), body: { bankId: 'hmac-bank', amount: 1_000 } });
  if (hmacDeposit.status === 201) {
    const ok = await bankConfirm({ reference: hmacDeposit.body.reference, amount: 1_000, bank: 'hmac-bank' });
    check('el banco con HMAC confirma con su secreto', ok.status, 200);
  }
});

await scenario('6. Pagos: cascada y rechazo de pagos mayores a la deuda', async () => {
  const c = await customer();
  await authorize(c, { amount: 60_000 });
  const paid = await pay(c, 20_000);
  check('pago de 20000 aplicado a capital', [paid.status, paid.body.applied, paid.body.debt], [201, [{ bucket: 'PRINCIPAL', amount: 20_000 }], 40_000]);
  const a = await account(c);
  check('el disponible se restaura a 50000', a.availableCredit, 50_000);
  const over = await pay(c, 40_001);
  check('pago mayor que la deuda: 422 PAYMENT_EXCEEDS_DEBT', [over.status, over.body.code], [422, 'PAYMENT_EXCEEDS_DEBT']);
  const movements = await call(urls.lending, 'GET', `/accounts/${c.cardId}/movements`, { auth: c.user });
  check('el diario muestra la compra y el pago', movements.body.map((m) => m.type).sort(), ['PAYMENT', 'PURCHASE']);
});

await scenario('7. Reversos de autorizaciones', async () => {
  const c = await customer();
  const auth = await authorize(c, { amount: 10_000 });
  const reversal = await call(urls.lending, 'POST', `/accounts/${c.cardId}/authorizations/${auth.body.authorizationId}/reversals`, { auth: network, key: key() });
  check('el reverso devuelve el crédito', [reversal.status, reversal.body.amount], [201, 10_000]);
  const again = await call(urls.lending, 'POST', `/accounts/${c.cardId}/authorizations/${auth.body.authorizationId}/reversals`, { auth: network, key: key() });
  check('un segundo reverso se rechaza (409)', again.status, 409);
  check('disponible completo de nuevo', (await account(c)).availableCredit, 90_000);
});

await scenario('8. Compras diferidas: validaciones y efecto en el cupo', async () => {
  const c = await customer();
  const invalid = await authorize(c, { amount: 12_000, installments: 4 });
  check('4 cuotas no se ofrecen (422)', [invalid.status, invalid.body.code], [422, 'INSTALLMENTS_NOT_AVAILABLE']);
  const small = await authorize(c, { amount: 4_999, installments: 3 });
  check('bajo el monto mínimo (422)', [small.status, small.body.code], [422, 'AMOUNT_BELOW_INSTALLMENT_MINIMUM']);
  const ok = await authorize(c, { amount: 12_000, installments: 3 });
  check('12000 a 3 cuotas aprobada y el cupo baja por el monto completo', [ok.status, ok.body.availableCredit, ok.body.installments], [201, 78_000, 3]);
  const a = await account(c);
  check('queda como saldo diferido y no como capital', [a.balances.deferred, a.balances.principal], [12_000, 0]);
  const payment = await pay(c, 1);
  check('lo diferido no se puede pagar por adelantado (422)', payment.status, 422);
  const reversal = await call(urls.lending, 'POST', `/accounts/${c.cardId}/authorizations/${ok.body.authorizationId}/reversals`, { auth: network, key: key() });
  check('antes del primer corte se puede reversar', reversal.status, 201);
});

await scenario('9. Cambio de cupo por un segundo depósito (evento SNS/SQS)', async () => {
  const c = await customer();
  const deposit = await call(urls.collateral, 'POST', `/custody-accounts/${c.custodyId}/deposits`, { auth: c.user, key: key(), body: { bankId: 'sim-bank', amount: 50_000 } });
  await bankConfirm({ reference: deposit.body.reference, amount: 50_000 });
  const raised = await until(() => account(c), (a) => a.limit.cupo === 135_000, 20_000);
  check('lending refleja el cupo de 135000 (llega por evento, sin consultar a custodia en la petición)', raised.limit.cupo, 135_000);
});

await scenario('10. Reducción de cupo', async () => {
  const c = await customer();
  await authorize(c, { amount: 20_000 });
  const tooLow = await call(urls.lending, 'POST', `/accounts/${c.cardId}/limit-reduction`, { auth: c.user, key: key(), body: { newCupo: 19_999 } });
  check('un cupo menor que la deuda se rechaza (422)', [tooLow.status, tooLow.body.code], [422, 'DEBT_EXCEEDS_NEW_LIMIT']);
  const reduced = await call(urls.lending, 'POST', `/accounts/${c.cardId}/limit-reduction`, { auth: c.user, key: key(), body: { newCupo: 45_000 } });
  check('reducción a 45000 aplicada', [reduced.status, reduced.body.status], [200, 'APPLIED']);
  const a = await account(c);
  check('cupo 45000 y disponible 25000', [a.limit.cupo, a.availableCredit], [45_000, 25_000]);
  const held = await custodyAccount(c);
  check('custodia liberó el colateral sobrante (retiene 50000)', held.heldAmount, 50_000);
});

await scenario('11. Facturación con reloj de desarrollo: estado de cuenta, cuota, mora y recuperación', async () => {
  const clock = await call(urls.lending, 'GET', '/internal/dev/clock', { auth: scheduler });
  if (clock.status !== 200) {
    check('el reloj de desarrollo está activo (DEV_CLOCK=true en lending)', clock.status, 200);
    return;
  }
  const c = await customer();
  await authorize(c, { amount: 60_000 });
  await authorize(c, { amount: 12_000, installments: 3 });

  await advanceDays(35);
  const cut = await runJobs();
  check('el job emite al menos un estado de cuenta', cut.statementsIssued >= 1, true);
  const statement = await call(urls.lending, 'GET', `/accounts/${c.cardId}/statements/1`, { auth: c.user });
  const s = statement.body;
  check('la primera cuota diferida (12000 / 3) se factura', [s.installmentPrincipal, s.deferredPurchases, s.deferredBalance], [4_000, 12_000, 8_000]);
  check('hay interés sobre el capital de la compra normal', s.interestCharged > 0, true);
  check('el saldo final cuadra: compras + interés + cuota', s.closingBalance, 60_000 + s.interestCharged + 4_000);
  check('el pago mínimo no es menor que la cuota', s.minimumPayment >= 4_000, true);

  await advanceDays(20);
  const late = await runJobs();
  check('pasado el vencimiento sin pagar, se cobra mora', late.statementsLate >= 1, true);
  const delinquent = await account(c);
  check('la cuenta queda DELINQUENT con cargo por mora', [delinquent.status, delinquent.balances.fees > 0], ['DELINQUENT', true]);
  const blocked = await authorize(c, { amount: 100 });
  check('una cuenta en mora no puede comprar', [blocked.body.status, blocked.body.reason], ['DECLINED', 'ACCOUNT_NOT_ACTIVE']);

  const cured = await pay(c, s.minimumPayment);
  check('pagar el mínimo se acepta', cured.status, 201);
  check('la cuenta vuelve a ACTIVE', (await account(c)).status, 'ACTIVE');
  const plans = await call(urls.lending, 'GET', `/accounts/${c.cardId}/installment-plans`, { auth: c.user });
  check('el plan de cuotas muestra al menos una cuota facturada', plans.body[0].billed >= 1, true);
});

await scenario('12. Cierre: el colateral se aplica a la deuda y el resto se libera', async () => {
  const c = await customer();
  await authorize(c, { amount: 30_000 });
  await authorize(c, { amount: 12_000, installments: 3 });
  const closed = await call(urls.lending, 'POST', `/accounts/${c.cardId}/closure`, { auth: c.user, key: key() });
  check('el cierre responde CLOSED con deuda 0', [closed.status, closed.body], [200, { status: 'CLOSED', debt: 0 }]);
  const held = await custodyAccount(c);
  check('custodia queda CLOSED sin saldo retenido', [held.status, held.heldAmount], ['CLOSED', 0]);
  const a = await account(c);
  check('la tarjeta queda CLOSED sin deuda', [a.status, a.balances.debt], ['CLOSED', 0]);
  const after = await authorize(c, { amount: 1 });
  check('no se puede comprar con una cuenta cerrada', [after.body.status, after.body.reason], ['DECLINED', 'ACCOUNT_NOT_ACTIVE']);
  const again = await call(urls.lending, 'POST', `/accounts/${c.cardId}/closure`, { auth: c.user, key: key() });
  check('cerrar dos veces se rechaza (409)', again.status, 409);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} verificaciones correctas`);
if (failed.length > 0) {
  console.log('\nFallaron:');
  for (const f of failed) console.log(`  [${f.scenario}] ${f.description}`);
  process.exit(1);
}
