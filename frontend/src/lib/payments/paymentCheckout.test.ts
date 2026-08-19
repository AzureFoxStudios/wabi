import { describe, expect, test, mock } from 'bun:test';

// paymentCheckout pulls in addonInventory (which uses Vite-only
// import.meta.glob and, transitively, the $app/environment virtual module);
// stub both — mapIntent under test does not use them.
mock.module('../addonInventory', () => ({ hasAddonCapability: async () => false }));
mock.module('$app/environment', () => ({ browser: false, dev: false, building: false }));

const { mapIntent } = await import('../api/paymentCheckout');

describe('mapIntent', () => {
	test('maps a promptpay intent from the Rust shape', () => {
		const intent = mapIntent({
			id: 'pi_abc',
			userId: 3,
			provider: 'promptpay',
			amountMinor: 50000,
			currency: 'THB',
			status: 'pending',
			note: 'commission',
			promptpayProxyId: '0812345678',
			promptpayQrPayload: '00020101021129370016A0000006770101110113006681234567805303765802TH5912COMMISSIONID6304ABCD',
			createdAt: 1787063059945,
			updatedAt: 1787063059945
		});
		expect(intent.pluginId).toBe('promptpay');
		expect(intent.providerName).toBe('PromptPay');
		expect(intent.countryCode).toBe('TH');
		expect(intent.currency).toBe('THB');
		expect(intent.checkoutMode).toBe('qr');
		expect(intent.customerRef).toBe('0812345678');
		expect(intent.metadata?.methodId).toBe('promptpay_qr');
		expect(intent.presentation?.mode).toBe('qr');
		expect(intent.presentation?.qrData).toContain('000201010211');
	});

	test('maps a payments-eu intent with a parsed presentation blob', () => {
		const intent = mapIntent({
			id: 'pi_eu',
			provider: 'payments-eu',
			methodId: 'epc_qr',
			countryCode: 'DE',
			providerRef: 'DE33100205000001194700',
			amountMinor: 2700,
			currency: 'EUR',
			status: 'pending',
			presentationJson: JSON.stringify({
				mode: 'qr',
				qrData: 'BCD\n002\n1\nSCT\n\nWABI\nDE33100205000001194700\nEUR27\n\nWABI-AB12',
				referenceCode: 'WABI-AB12',
				rail: 'sepa-instant'
			}),
			createdAt: 1,
			updatedAt: 1
		});
		expect(intent.pluginId).toBe('payments-eu');
		expect(intent.providerName).toBe('SEPA Instant');
		expect(intent.countryCode).toBe('DE');
		expect(intent.checkoutMode).toBe('qr');
		expect(intent.customerRef).toBe('DE33100205000001194700');
		expect(intent.metadata?.methodId).toBe('epc_qr');
		expect(intent.presentation?.referenceCode).toBe('WABI-AB12');
		expect(intent.presentation?.qrData).toContain('EUR27');
	});

	test('maps a payments-us intent into an app_switch', () => {
		const intent = mapIntent({
			id: 'pi_us',
			provider: 'payments-us',
			methodId: 'zelle_pointer',
			countryCode: 'US',
			providerRef: 'mika@example.com',
			amountMinor: 5000,
			currency: 'USD',
			status: 'pending',
			presentationJson: JSON.stringify({
				mode: 'app_switch',
				pointer: 'mika@example.com',
				pointerLabel: 'Zelle',
				referenceCode: 'WABI-9X2K',
				disclosure: 'Zelle shows your bank-registered legal name.'
			}),
			createdAt: 1,
			updatedAt: 1
		});
		expect(intent.pluginId).toBe('payments-us');
		expect(intent.checkoutMode).toBe('app_switch');
		expect(intent.metadata?.providerRef).toBe('mika@example.com');
		expect(intent.presentation?.pointerLabel).toBe('Zelle');
	});

	test('falls back to the promptpay shape when fields are absent', () => {
		const intent = mapIntent({ id: 'pi_x', provider: 'payments-crypto', amountMinor: 100, currency: 'USDC' });
		expect(intent.pluginId).toBe('payments-crypto');
		expect(intent.currency).toBe('USDC');
		expect(intent.checkoutMode).toBe('qr');
		expect(intent.metadata?.methodId).toBe('promptpay_qr'); // legacy fallback, promptpay-shaped default
	});
});