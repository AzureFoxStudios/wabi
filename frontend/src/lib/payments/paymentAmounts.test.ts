import { describe, expect, test } from 'bun:test';
import { getCurrencyMinorUnit, parseMajorAmountInput } from './paymentAmounts';

describe('getCurrencyMinorUnit', () => {
	test('fiat currencies default to 2', () => {
		expect(getCurrencyMinorUnit('EUR')).toBe(2);
		expect(getCurrencyMinorUnit('USD')).toBe(2);
		expect(getCurrencyMinorUnit('THB')).toBe(2);
	});

	test('crypto decimals match the Rust addon crates', () => {
		expect(getCurrencyMinorUnit('USDC')).toBe(6);
		expect(getCurrencyMinorUnit('USDT')).toBe(6);
		expect(getCurrencyMinorUnit('BTC')).toBe(8);
		expect(getCurrencyMinorUnit('XMR')).toBe(12);
	});
});

describe('parseMajorAmountInput', () => {
	test('parses fiat amounts into cents', () => {
		expect(parseMajorAmountInput('12.34', 'EUR')).toBe(1234);
		expect(parseMajorAmountInput('27', 'EUR')).toBe(2700);
		expect(parseMajorAmountInput('0.2', 'USD')).toBe(20);
	});

	test('parses USDC/USDT into 6-decimal minor units', () => {
		expect(parseMajorAmountInput('1.25', 'USDC')).toBe(1_250_000);
		expect(parseMajorAmountInput('10', 'USDT')).toBe(10_000_000);
	});

	test('parses BTC into satoshis and XMR into piconero', () => {
		expect(parseMajorAmountInput('0.001', 'BTC')).toBe(100_000);
		expect(parseMajorAmountInput('0.1', 'XMR')).toBe(100_000_000_000);
	});

	test('truncates excess decimals instead of rounding', () => {
		expect(parseMajorAmountInput('1.23456789', 'USDC')).toBe(1_234_567);
		expect(parseMajorAmountInput('0.000000000001234', 'XMR')).toBe(1);
	});
});