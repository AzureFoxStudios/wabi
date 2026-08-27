export const page = {
	get current() {
		return { url: new URL('http://localhost/'), params: {}, data: {}, route: {} };
	}
};
export const navigating = {
	get current() {
		return null;
	}
};
export const updated = {
	get current() {
		return false;
	},
	subscribe: () => () => {}
};
