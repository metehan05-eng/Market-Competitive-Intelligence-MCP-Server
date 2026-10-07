import type { PageSnapshot } from "../engine.js";
import type { ParseResult } from "../../types.js";
export declare function extractTechStack(text: string): string[];
/** Parses career-portal content into structured job posting intelligence. */
export declare function parseHr(snapshot: PageSnapshot): ParseResult;
