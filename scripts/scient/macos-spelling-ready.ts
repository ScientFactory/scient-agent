import { macOSCheckSpelling } from "../../packages/natives/native/index.js";

// AppKit can time out its first XPC request while the runner's spelling service starts.
const probe = "qzxvplmokn";
let ready = false;
for (let attempt = 1; attempt <= 3; attempt++) {
	const ranges = await macOSCheckSpelling(probe);
	if (ranges.some(range => range.start === 0 && range.length === probe.length)) {
		console.log(`macOS spelling service ready (probe ${attempt}/3)`);
		ready = true;
		break;
	}
}
if (!ready)
	throw new Error("macOS spelling service did not become ready after 3 probes; native tests cannot qualify it");
