import type { PageSnapshot } from "../engine.js";
import type { ParseResult } from "../../types.js";
/** Parses competitor storefronts into product price & stock intelligence (ecommerce). */
export declare function parseEcommerce(snapshot: PageSnapshot): ParseResult;
