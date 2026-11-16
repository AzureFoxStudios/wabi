/**
 * What the `=` autocomplete offers: each function the calculator supports, with the signature
 * Excel users expect to see and a one-line summary. A test keeps this list identical to
 * FORMULA_FUNCTIONS in formula.ts, so a function can neither be offered without working nor
 * work without being offered.
 */
export interface FunctionInfo {
	name: string;
	signature: string;
	summary: string;
}

export const FUNCTION_CATALOG: FunctionInfo[] = [
	{ name: 'ABS', signature: 'ABS(number)', summary: 'The absolute value of a number.' },
	{ name: 'AND', signature: 'AND(logical1, [logical2], …)', summary: 'TRUE when every argument is TRUE.' },
	{ name: 'AVERAGE', signature: 'AVERAGE(number1, [number2], …)', summary: 'The average of the numbers.' },
	{ name: 'CONCAT', signature: 'CONCAT(text1, [text2], …)', summary: 'Joins text from several cells or values.' },
	{ name: 'COUNT', signature: 'COUNT(value1, [value2], …)', summary: 'How many of the values are numbers.' },
	{ name: 'COUNTA', signature: 'COUNTA(value1, [value2], …)', summary: 'How many of the values are not empty.' },
	{ name: 'COUNTIF', signature: 'COUNTIF(range, criteria)', summary: 'How many cells in the range meet the condition.' },
	{ name: 'IF', signature: 'IF(logical_test, value_if_true, [value_if_false])', summary: 'One value if a condition is true, another if it is not.' },
	{ name: 'MAX', signature: 'MAX(number1, [number2], …)', summary: 'The largest number.' },
	{ name: 'MIN', signature: 'MIN(number1, [number2], …)', summary: 'The smallest number.' },
	{ name: 'NOT', signature: 'NOT(logical)', summary: 'Reverses TRUE and FALSE.' },
	{ name: 'OR', signature: 'OR(logical1, [logical2], …)', summary: 'TRUE when any argument is TRUE.' },
	{ name: 'ROUND', signature: 'ROUND(number, [num_digits])', summary: 'Rounds a number to a number of digits.' },
	{ name: 'SUM', signature: 'SUM(number1, [number2], …)', summary: 'Adds the numbers.' },
	{ name: 'SUMIF', signature: 'SUMIF(range, criteria, [sum_range])', summary: 'Adds the cells that meet a condition.' }
];
