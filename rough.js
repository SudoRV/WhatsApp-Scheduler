const localTime = new Date();

const d = new Date(localTime);
const utcISO = new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString();

console.log(localTime, "  ", utcISO, "  ", d.getTimezoneOffset())