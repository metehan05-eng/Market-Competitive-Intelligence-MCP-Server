import { parseContent, parseSocial } from "./contentParser.js";
import { parseEcommerce } from "./ecommerceParser.js";
import { parseHr } from "./hrParser.js";
import { parseRealEstate } from "./realEstateParser.js";
import { parseSaas } from "./saasParser.js";
export { parseContent, parseSocial, parseEcommerce, parseHr, parseRealEstate, parseSaas };
export * from "./shared.js";
/**
 * Routes a page snapshot to the heuristic parser matching its intelligence category.
 */
export function parseByCategory(category, snapshot) {
    switch (category) {
        case "hr_talent":
            return parseHr(snapshot);
        case "content_pr":
            return parseContent(snapshot);
        case "social_trends":
            return parseSocial(snapshot);
        case "real_estate":
            return parseRealEstate(snapshot);
        case "saas_pricing":
            return parseSaas(snapshot);
        case "ecommerce":
            return parseEcommerce(snapshot);
        default: {
            const exhaustive = category;
            throw new Error(`Unsupported category: ${String(exhaustive)}`);
        }
    }
}
//# sourceMappingURL=index.js.map