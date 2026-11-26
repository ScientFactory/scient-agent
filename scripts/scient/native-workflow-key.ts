interface WorkflowJob {
	needs?: string | string[];
	steps?: { id?: string; uses?: string; [key: string]: unknown }[];
}

type Workflow = { jobs: Record<string, WorkflowJob> } & Record<string, unknown>;

// Both jobs may publish the Linux x64 key. Include their build steps and all prerequisite jobs.
export function nativeWorkflowKey({ jobs, ...settings }: Workflow): string {
	const prerequisites: Record<string, WorkflowJob> = {};
	function includePrerequisite(id: string): void {
		if (Object.hasOwn(prerequisites, id)) return;
		const job = jobs[id];
		if (!job) throw new Error(`Missing workflow job: ${id}`);
		prerequisites[id] = job;
		for (const dependency of [job.needs ?? []].flat()) includePrerequisite(dependency);
	}
	const producers = ["build", "natives-linux"].map(id => {
		const job = jobs[id];
		const steps = job?.steps;
		const save = steps?.findIndex(step => step.id === "save-native" && step.uses?.startsWith("actions/cache/save@"));
		if (!steps || save === undefined || save < 0) throw new Error(`Missing native cache save in ${id}`);
		for (const dependency of [job.needs ?? []].flat()) includePrerequisite(dependency);
		return { ...job, steps: steps.slice(0, save + 1) };
	});
	return new Bun.CryptoHasher("sha256").update(JSON.stringify({ settings, prerequisites, producers })).digest("hex");
}

if (import.meta.main) {
	const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/scient.yml").text()) as Workflow;
	console.log(nativeWorkflowKey(workflow));
}
