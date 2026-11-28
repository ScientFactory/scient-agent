interface WorkflowJob {
	steps: { id?: string; uses?: string; [key: string]: unknown }[];
}

type Workflow = { jobs: { native: WorkflowJob } } & Record<string, unknown>;

// Hash the producer through cache save. Artifact upload and qualification do not change the addon.
export function nativeWorkflowKey({ jobs, ...settings }: Workflow): string {
	const { steps, ...job } = jobs.native;
	const save = steps.findIndex(step => step.id === "save-native" && step.uses?.startsWith("actions/cache/save@"));
	if (save < 0) throw new Error("Missing native cache save");
	return new Bun.CryptoHasher("sha256")
		.update(JSON.stringify({ settings, job, steps: steps.slice(0, save + 1) }))
		.digest("hex");
}

if (import.meta.main) {
	const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/scient-native.yml").text()) as Workflow;
	console.log(nativeWorkflowKey(workflow));
}
