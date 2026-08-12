// End-to-end check for the Kiro CLI usage command. It prints usage, never tokens.
import { getKiroUsage } from "../src/usage"

console.log(await getKiroUsage())
