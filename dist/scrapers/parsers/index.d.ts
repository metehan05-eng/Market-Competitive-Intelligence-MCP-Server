import type { PageSnapshot } from "../engine.js";
import type { Category, ParseResult } from "../../types.js";
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
export declare function parseByCategory(category: Category, snapshot: PageSnapshot): ParseResult;
