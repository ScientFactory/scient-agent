/**
 * A host with its own browser sets SCIENT_AGENT_HOST_PAGES=1. The agent then
 * reports a page's address instead of opening the system browser beside it.
 */
export function hostShowsPages(): boolean {
	return process.env.SCIENT_AGENT_HOST_PAGES === "1";
}
