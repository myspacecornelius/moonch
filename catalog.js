/* Generated from research/*.json. See scripts/build-catalog.cjs. */
window.FinanceCatalog = {
  "schemaVersion": 1,
  "kind": "finance-research-catalog",
  "updatedAt": "2026-10-07",
  "sources": [
    {
      "id": "finverbench",
      "title": "FinVerBench: Benchmark Validity and Calibration in Large Language Model Financial Statement Verification",
      "url": "https://arxiv.org/html/2605.29586v1",
      "version": "arXiv 2605.29586v1, 2026-05-28",
      "status": "verified",
      "summary": "Primary-source review supplied with this project. verified primary report not reproduced. No task-specific run or independent replication is established.",
      "claims": [
        "Four categories and twelve defined subtypes; eleven instantiated because CL-D&A is excluded.",
        "Claude Sonnet 4 recall changes from 100.0% to 79.0% after rounding in the same 105-instance observable sample: 43 clean and 62 injected. Observed FPR stays zero.",
        "Simplified statements can provoke false positives when omitted items are assumed zero.",
        "Source anchors: Section 3.3; Table 2; Appendix C/Table 13; Section 6.4/Table 10; Section 6.5/Table 11; Section 7.2; Section 8"
      ],
      "limits": "Single guided-checklist setting; no general model-ranking or target-platform difficulty inference. Hidden-field positives were excluded or treated as insufficient information. Paper claims code availability but defers its repository URL to a camera-ready version; no repository independently located."
    },
    {
      "id": "finrate",
      "title": "Fin-RATE: A Real-world Financial Analytics and Tracking Evaluation Benchmark for LLMs on SEC Filings",
      "url": "https://arxiv.org/html/2602.07294v4",
      "version": "arXiv 2602.07294v4, 2026-06-10",
      "status": "verified",
      "summary": "Primary-source review supplied with this project. verified primary report not reproduced. No task-specific run or independent replication is established.",
      "claims": [
        "Thirteen core error types in four categories; finer hallucination and query-understanding subtypes are nested, not additional core types.",
        "Three 2,500-question pathways cover detail reasoning, entity comparison, and longitudinal tracking.",
        "Error taxonomy explicitly separates missing/ranked/distracting evidence, unsupported generation, numerical/semantic errors, and query/context comprehension.",
        "Source anchors: Section 3.1; Section 4.2.1; Section 4.3.1/Table 2; Appendix I.1-I.4"
      ],
      "limits": "LLM-judge fusion produces error labels; their counts are not independently observed causal mechanisms. Entity and year mismatches support candidate designs, not claims about this task family."
    },
    {
      "id": "finrate_release",
      "title": "Fin-RATE official repository and dataset",
      "url": "https://github.com/jyd777/Fin-RATE",
      "version": "live pages read 2026-10-07",
      "status": "partially-verified",
      "summary": "Primary-source review supplied with this project. identity verified only. No task-specific run or independent replication is established.",
      "claims": [
        "Both destinations are linked directly by the paper.",
        "Source anchors: Repository landing page; Dataset landing page"
      ],
      "limits": "Release contents and numerical results were not independently executed or fully audited in this pass."
    },
    {
      "id": "finsheet",
      "title": "FinSheet-Bench: From Simple Lookups to Complex Reasoning, Where LLMs Break on Financial Spreadsheets",
      "url": "https://arxiv.org/html/2603.07316v1",
      "version": "arXiv 2603.07316v1, 2026-03-07",
      "status": "verified",
      "summary": "Primary-source review supplied with this project. verified primary report not reproduced. No task-specific run or independent replication is established.",
      "claims": [
        "Gemini 3.1 Pro reports 82.4% overall accuracy.",
        "The 48.6% largest-file figure is an across-model file average, not this model's individual accuracy.",
        "Experiments use text-serialized synthetic portfolios; serialization drops visual cues and formula references. Twenty-four files vary layout and size.",
        "Source anchors: Sections 4.4-4.5.1; Section 5.1/Table 4; Section 5.2/Table 5; Section 5.6/Table 8; Sections 6.2 and 7; Appendix A"
      ],
      "limits": "Do not label these results native-Excel agent performance. Structural variants also change row counts and available columns, so raw variant gaps do not isolate layout causally. FinVerBench's related-work description incorrectly identifies the 82.4% model and conflates aggregation levels."
    },
    {
      "id": "failsafeqa",
      "title": "Expect the Unexpected: FailSafe Long Context QA for Finance",
      "url": "https://arxiv.org/html/2502.06329v1",
      "version": "arXiv 2502.06329v1, 2025-02-10",
      "status": "verified",
      "summary": "Primary-source review supplied with this project. verified primary report not reproduced. No task-specific run or independent replication is established.",
      "claims": [
        "Six perturbations: misspelled, incomplete, and out-of-domain queries; missing, OCR-degraded, and irrelevant context.",
        "The 220 base examples distinguish answer-preserving perturbations from cases requiring an insufficiency response.",
        "Source anchors: Sections 2.2-2.4; Sections 3.1-3.2; Appendix C.3"
      ],
      "limits": "This is robustness and grounding evaluation, not evidence that arbitrary corruption improves financial reasoning tests. Missing-source tasks are fair only when identifying insufficiency is an authorized outcome; do not demand an impossible numeric answer."
    },
    {
      "id": "hedgebench_paper",
      "title": "Hedge-Bench: Benchmarking Agents on Hard, Realistic Tasks Pertaining to Financial Reasoning",
      "url": "https://arxiv.org/html/2606.03918v1",
      "version": "arXiv 2606.03918v1",
      "status": "verified",
      "summary": "Primary-source review supplied with this project. verified primary report not reproduced. No task-specific run or independent replication is established.",
      "claims": [
        "102 tasks use company/peer source files and open-ended analytical themes.",
        "Grading uses an LLM judge for factual grounding, conceptual coverage, and opposing-evidence synthesis.",
        "A fabricated fact invalidates the affected reasoning move; equivalent supported framings can receive credit.",
        "Source anchors: Sections 3.1-3.3; Sections 4.1-4.3; Section 5.5; Section 6"
      ],
      "limits": "The rubric reflects particular analysts; valid off-rubric reasoning may exceed its measurement. Section 6 acknowledges possible rubric drift from transcripts. A low perfect-score rate is not a portable difficulty score. Do not transplant hidden mandatory themes into a task whose public request does not justify them."
    },
    {
      "id": "creditcardqa_paper",
      "title": "Credit Cards, Confusion, Computation, and Consequences: What Can We Uncover About Language Model Reasoning?",
      "url": "https://arxiv.org/html/2607.26952v1",
      "version": "arXiv 2607.26952v1",
      "status": "verified",
      "summary": "Primary-source review supplied with this project. verified primary report not reproduced. No task-specific run or independent replication is established.",
      "claims": [
        "Paper reports 1,800 questions with 800/1,000 development/test split; naming varies internally among CreditCardQA, CreditQA, and FinLitQA.",
        "In fifty sampled incorrect GPT-OSS-120B responses, nonexclusive labels include formula/rule substitution 35/50 and missed conditions 27/50.",
        "Question construction requires all necessary absent inputs/definitions to be supplied and one answer type.",
        "Source anchors: Section 2/Table 1; Section 5/Table 3; Section 6; Appendix B, Question Generation Process"
      ],
      "limits": "The error audit is not all models or all responses; overlapping rates must not be added. Agreement-specific branching, caps, and timing motivate candidate mechanisms but do not establish their hardness on the target platform. Public dataset release count must be reported separately from paper count."
    },
    {
      "id": "mbabench",
      "title": "MBABench: Evaluating LLM Agents on End-to-End Spreadsheet Tasks in Finance",
      "url": "https://arxiv.org/html/2605.22664v5",
      "version": "arXiv 2605.22664v5, 2026-08-19; v1 titled WorkstreamBench",
      "status": "verified",
      "summary": "Primary-source review supplied with this project. verified identity correction. No task-specific run or independent replication is established.",
      "claims": [
        "This identifier resolves to MBABench, not GAUGE.",
        "Three evaluation dimensions cover numerical/task accuracy, formula robustness/auditability, and presentation.",
        "Synthetic perturbation tests include hardcodes, ranges, signs, and edge cases.",
        "Source anchors: Abstract; Section 3; Table 2; Section 8"
      ],
      "limits": "Harnesses differ between API and proprietary tools; observed performance differences cannot be attributed solely to models. Judge perturbation checks are evidence about the grader, not proof that task mutations are hard."
    },
    {
      "id": "gauge",
      "title": "One Analyst Is Not Ground Truth: Grading Agent-Built Financial Models Against Observed Professional Practice",
      "url": "https://arxiv.org/html/2607.24889v2",
      "version": "arXiv 2607.24889v2, 2026-09-26; v1 GAUGE title",
      "status": "verified",
      "summary": "Primary-source review supplied with this project. verified primary report not reproduced. No task-specific run or independent replication is established.",
      "claims": [
        "Correct identifier is 2607.24889.",
        "Separates deterministically verifiable facts/relationships from judgment-bearing forecasts; single-reference audit has 108 directed pairs and median agreement score 0.33.",
        "Structural validity gates prevent critical defects being washed out by average credit.",
        "Source anchors: Sections 2.1-2.3; Section 3.3; Reproducibility Statement; Appendix H/Table 13; Appendix X"
      ],
      "limits": "Observed professional ranges are not truth or blanket permission for any answer. Latest paper promises repository/dataset links in a future version despite public-release language; independently downloadable release not verified. One provider network, nonindependent directed pairs, and mixed vintages/purposes limit generalization."
    },
    {
      "id": "financeqa_card",
      "title": "FinanceQA",
      "url": "https://huggingface.co/datasets/AfterQuery/FinanceQA",
      "version": "6eb03b46c2e7f71ad52f7db4d12a9eabd523f575",
      "status": "verified",
      "summary": "Primary-source review supplied with this project. verified primary report not reproduced. No task-specific run or independent replication is established.",
      "claims": [
        "Public viewer contains 148 test rows. [Location: Dataset Viewer / Split (1); Number of rows; primary_reported]",
        "Question labels are basic, assumption, conceptual. Tactical questions cover accounting, calculation and incomplete-information assumptions; conceptual questions cover financial relationships and principles. [Location: Description; Fields, README lines 14–33; primary_reported]",
        "Pinned source: https://huggingface.co/datasets/AfterQuery/FinanceQA/blob/6eb03b46c2e7f71ad52f7db4d12a9eabd523f575/README.md"
      ],
      "limits": "Card expresses an aim to be more challenging; it does not establish transferable difficulty for newly authored tasks. Reference rationale and answers must be withheld from solver context. Access: Public, ungated API response. Declared license: Apache-2.0 (README YAML line 2)"
    },
    {
      "id": "financebench_card",
      "title": "FinanceBench public sample",
      "url": "https://huggingface.co/datasets/PatronusAI/financebench",
      "version": "live primary page read 2026-10-07",
      "status": "verified",
      "summary": "Primary-source review supplied with this project. verified primary report not reproduced. No task-specific run or independent replication is established.",
      "claims": [
        "150 annotated public examples; 16 historical model configurations and 2,400 manually reviewed answers. [Location: Card paragraphs after viewer; primary_reported]",
        "Designed as clear-cut, straightforward open-book financial QA and a minimum performance standard. Includes answer/evidence strings and linked PDFs. [Location: Card description; viewer fields; primary_reported]"
      ],
      "limits": "Do not describe the 150 examples as the complete FinanceBench collection. Historical results are not current model performance. Noncommercial license is a reuse constraint. Access: Public sample; card directs requests for full-dataset evaluation to publisher. Declared license: CC-BY-NC-4.0 (Dataset header license)"
    },
    {
      "id": "hedge_hf",
      "title": "Trata Hedge Bench",
      "url": "https://huggingface.co/datasets/trytrata/trata-hedge-bench",
      "version": "125c4a82aa9ca83782fb313e378f329e9fb95ed7",
      "status": "verified",
      "summary": "Primary-source review supplied with this project. verified primary report not reproduced. No task-specific run or independent replication is established.",
      "claims": [
        "102 task rows; separate documents configuration has one row per task/file pair. [Location: Loading; Configs, README lines 34–78; primary_reported]",
        "Task schema includes analysis_date cutoff, instruction, rubric, LLM-judge prompts and source-file paths. Runnable Harbor environments require Docker and a Gemini grader key. [Location: Configs; Running the benchmark, README lines 50–89; primary_reported]",
        "API manifest contains 102 instruction.md environment files. [Location: API siblings manifest; independently_counted_release_metadata]",
        "Pinned source: https://huggingface.co/datasets/trytrata/trata-hedge-bench/blob/125c4a82aa9ca83782fb313e378f329e9fb95ed7/README.md"
      ],
      "limits": "Task count is not combined task-plus-document row count. Public rubrics create evaluation-contamination risk. No model run reproduced. Access: Public, ungated. Standard web extractor failed; public raw README and API fetched successfully. Declared license: CC-BY-NC-4.0 (README YAML line 2)"
    },
    {
      "id": "hedge_repo",
      "title": "Trata Hedge-Bench runnable repository",
      "url": "https://github.com/Trata-Inc/trata-hedge-bench",
      "version": "live primary page read 2026-10-07",
      "status": "verified",
      "summary": "Primary-source review supplied with this project. verified primary report not reproduced. No task-specific run or independent replication is established.",
      "claims": [
        "Open-ended tasks pair a closed corpus with a reference solution and tests. A typical task is described as three or four themes, each with four or five action moves. [Location: Task Formulation; primary_reported]",
        "Despite introductory deterministic-grading wording, Task format explicitly says semantic concept matching uses an LLM judge and rubric. [Location: Introduction versus Task format; primary_reported]"
      ],
      "limits": "Do not call the implemented grading entirely deterministic or judge-free. Expert-congruent analysis need not be a uniquely correct investment conclusion. Access: Public repository; prerequisites Harbor, Docker, Gemini API key. Declared license: No separate LICENSE file located in inspected root; associated HF release declares CC-BY-NC-4.0. (Root file list; Quickstart)"
    },
    {
      "id": "hedge_example",
      "title": "Apollo capital allocation task",
      "url": "https://github.com/Trata-Inc/trata-hedge-bench/blob/main/environments/apo-2026-03-12-capital-allocation-buybacks-vs-dividends/instruction.md",
      "version": "live primary page read 2026-10-07",
      "status": "verified",
      "summary": "Primary-source review supplied with this project. verified primary report not reproduced. No task-specific run or independent replication is established.",
      "claims": [
        "Five named themes; requires a position, file-level evidence, strongest counter-evidence, reconciliation of conflicting data and explicit ambiguity. Ungrounded claims are excluded from grading. [Location: Cover these themes; Your answer must; primary_reported]"
      ],
      "limits": "This five-theme example exceeds the README’s stated typical three/four themes, not necessarily a contradiction. The theme title presupposes buyback superiority; fair new tasks should allow evidence-supported alternatives. Access: Public instruction fetched from raw GitHub. Declared license: Associated HF release: CC-BY-NC-4.0 (undefined)"
    },
    {
      "id": "creditqa_card",
      "title": "CCA Numerical Reasoning / CreditQA release",
      "url": "https://huggingface.co/datasets/gtfintechlab/CreditQA",
      "version": "2bb9c66f19805f31396cd6c3e426a7bd7541dfaf",
      "status": "verified",
      "summary": "Primary-source review supplied with this project. verified primary report not reproduced. No task-specific run or independent replication is established.",
      "claims": [
        "800 numerical questions from 27 agreements. Schema records answers, units, document/user input provenance, steps, program, first/third-person metadata and agreement identifier. [Location: README lines 20–84; primary_reported]",
        "Downloaded creditqa.json has 800 rows, 27 distinct agreement identifiers, 607 THIRD and 193 FIRST labels. [Location: https://huggingface.co/datasets/gtfintechlab/CreditQA/resolve/2bb9c66f19805f31396cd6c3e426a7bd7541dfaf/creditqa.json; independently_counted_release_data]",
        "Pinned source: https://huggingface.co/datasets/gtfintechlab/CreditQA/blob/2bb9c66f19805f31396cd6c3e426a7bd7541dfaf/README.md"
      ],
      "limits": "Card size category says 1K–10K despite 800 released rows. Paper reports 1,800 questions; do not equate paper population with this public release. Access: Public, ungated; raw fetch succeeded despite web extractor failure. Declared license: CC-BY-NC-SA-4.0 (README YAML line 2)"
    },
    {
      "id": "creditqa_repo",
      "title": "CreditCardQA code repository",
      "url": "https://github.com/gtfintechlab/CreditQA",
      "version": "live primary page read 2026-10-07",
      "status": "verified",
      "summary": "Primary-source review supplied with this project. verified primary report not reproduced. No task-specific run or independent replication is established.",
      "claims": [
        "Contains direct-context inference, RAG and evaluation code; questions, agreement texts and two evaluation helper files are kept outside git. [Location: Contents; Data Layout; Evaluation; primary_reported]"
      ],
      "limits": "Code access is not confirmation of complete reproducibility or all data availability. Access: Public code, but README’s local data paths do not themselves supply those files. Declared license: No license visible in inspected root. (undefined)"
    },
    {
      "id": "emb_methodology",
      "title": "Excel Modeling Benchmark",
      "url": "https://www.vals.ai/benchmarks/emb",
      "version": "Page updated 2026-10-06; retrieved 2026-10-07",
      "status": "verified",
      "summary": "Primary-source review supplied with this project. verified primary report not reproduced. No task-specific run or independent replication is established.",
      "claims": [
        "103 expert-authored, peer-reviewed tasks: 1 public, 51 licensable validation, 51 held-out test. Seven model families. [Location: Dataset; Task Taxonomy; primary_reported]",
        "Template mode grades matching cell values; Scratch mode uses an agentic judge for numerical, formula and presentation checks. Excel recalculates submissions; some tasks test multiple scenarios. Categories are equally weighted; time cap is 3.5 hours. [Location: Methodology; primary_reported]"
      ],
      "limits": "Partial-credit scores do not imply client-ready work. No score or workbook independently reproduced. New tasks cannot inherit published leaderboard difficulty. Access: Proprietary; full task collection is not openly downloadable. Declared license: No blanket reusable-data license found; validation requires licensing. (undefined)"
    },
    {
      "id": "ragas_concepts",
      "title": "Testset Generation for RAG: concepts",
      "url": "https://docs.ragas.io/en/stable/concepts/test_data_generation/rag/",
      "version": "live primary page read 2026-10-07",
      "status": "verified",
      "summary": "Primary-source review supplied with this project. verified primary report not reproduced. No task-specific run or independent replication is established.",
      "claims": [
        "Knowledge graphs support single/multi-hop and specific/abstract queries; finance example chunks by statement section and links company entities. Scenarios combine nodes, style, length and persona; synthesizers produce queries and references. [Location: Query types; Knowledge Graph Creation; Scenario Generation; official_documentation]"
      ],
      "limits": "Concept page still marks personas “Coming soon”; separate official persona guide provides working API. Generation machinery does not certify answer correctness or task difficulty. Access: Public docs. Declared license: Ragas repository Apache-2.0; source corpora need their own permissions. (undefined)"
    },
    {
      "id": "ragas_quickstart",
      "title": "Testset Generation for RAG: quickstart",
      "url": "https://docs.ragas.io/en/stable/getstarted/rag_testset_generation/",
      "version": "live primary page read 2026-10-07",
      "status": "verified",
      "summary": "Primary-source review supplied with this project. verified primary report not reproduced. No task-specific run or independent replication is established.",
      "claims": [
        "Generate from supplied documents, enrich a knowledge graph, configure query-type distribution, export examples and select suitable queries for final use. Example distribution is 0.5 single-hop specific, 0.25 multi-hop abstract and 0.25 multi-hop specific. [Location: Analyzing the testset; A Deeper Look / Testset Generation; official_documentation]"
      ],
      "limits": "Example distribution is not a finance-difficulty prescription. Inspect generated references before treating them as gold. Access: Public docs; execution uses configured model and embedding providers. Declared license: undefined (undefined)"
    },
    {
      "id": "ragas_personas",
      "title": "Persona Generation",
      "url": "https://docs.ragas.io/en/stable/howtos/customizations/testgenerator/_persona_generator/",
      "version": "live primary page read 2026-10-07",
      "status": "verified",
      "summary": "Primary-source review supplied with this project. verified primary report not reproduced. No task-specific run or independent replication is established.",
      "claims": [
        "Persona accepts name and role description; persona_list is passed into TestsetGenerator. [Location: Persona’s in Testset Generation; official_documentation]"
      ],
      "limits": "Persona variation alone is not evidence of increased reasoning difficulty. Access: Public docs. Declared license: undefined (undefined)"
    }
  ],
  "mechanisms": [
    {
      "id": "entity_perimeter",
      "title": "Entity and ownership perimeter",
      "description": "A retrieved figure is used for the wrong legal entity or ownership scope.",
      "designQuestion": "Bind each input to its permitted entity before building the decision ledger.",
      "status": "Source-motivated design hypothesis; not tested on this task. No hardness claim allowed.",
      "sourceIds": [
        "finrate"
      ],
      "requirements": [
        "Entity identifiers and group relationships",
        "Scope attached to each cash, debt, cost, or earnings figure",
        "Any transfer or use restrictions"
      ],
      "fairness": [
        "All relevant entity labels and restrictions must be visible",
        "Do not require outside corporate-law assumptions"
      ],
      "leakage": [
        "Do not label files as the entity-confusion trap",
        "Use comparable naming quality across entities"
      ],
      "wrongReading": "Treat group cash as automatically available to every subsidiary.",
      "decisionImpact": "Can reverse a funding or covenant conclusion.",
      "evidence": [
        "finrate: Section 4.3.1; Appendix I.4"
      ]
    },
    {
      "id": "period_alignment",
      "title": "Period and effective-date alignment",
      "description": "A date-valid fact is carried into the wrong reporting or operating window.",
      "designQuestion": "Determine which facts govern each interval, then align the comparison.",
      "status": "Source-motivated design hypothesis; not tested on this task. No hardness claim allowed.",
      "sourceIds": [
        "finrate"
      ],
      "requirements": [
        "As-of date",
        "Fiscal/calendar period definitions",
        "Effective dates, expiry dates, and opening/closing balances"
      ],
      "fairness": [
        "State inclusion/exclusion conventions for boundary days when material",
        "Supply any restatement or supersession rule"
      ],
      "leakage": [
        "Avoid filenames that reveal the governing document",
        "Ensure no post-as-of answer information enters the solver pack"
      ],
      "wrongReading": "Use a year-end facility limit for months before it becomes available.",
      "decisionImpact": "Changes peak liquidity need or trend interpretation.",
      "evidence": [
        "finrate: Appendix I.3; Section 4.3.1"
      ]
    },
    {
      "id": "metric_basis",
      "title": "Metric, unit, and denominator selection",
      "description": "Correct numbers are combined using incompatible definitions or scaling.",
      "designQuestion": "Choose comparable measures and convert only as the source permits.",
      "status": "Source-motivated design hypothesis; not tested on this task. No hardness claim allowed.",
      "sourceIds": [
        "finrate"
      ],
      "requirements": [
        "Units and currencies",
        "Gross/net and stock/flow definitions",
        "Relevant denominator and ownership basis"
      ],
      "fairness": [
        "Necessary conversions must be derivable",
        "Grading must recognize algebraically equivalent conventions"
      ],
      "leakage": [
        "Keep units equally legible for decisive and control inputs"
      ],
      "wrongReading": "Compare a percentage-point change with percentage growth, or use gross proceeds as net liquidity.",
      "decisionImpact": "Changes coverage, sizing, or threshold classification.",
      "evidence": [
        "finrate: Appendix I.3-I.4"
      ]
    },
    {
      "id": "incomplete_schedule",
      "title": "Completeness-aware reconciliation",
      "description": "A partial schedule is assumed exhaustive.",
      "designQuestion": "Separate a proven inconsistency from a reconciliation that lacks sufficient detail.",
      "status": "Source-motivated design hypothesis; not tested on this task. No hardness claim allowed.",
      "sourceIds": [
        "finverbench"
      ],
      "requirements": [
        "Schedule scope",
        "Reported total",
        "Included components",
        "Any disclosed omitted categories or bridge"
      ],
      "fairness": [
        "Permit an insufficiency finding when the pack cannot resolve the gap",
        "Never hide a gold-critical component and still require its value"
      ],
      "leakage": [
        "Do not mark one schedule as suspicious",
        "Include coherent clean controls"
      ],
      "wrongReading": "Declare fraud or an error because listed components do not equal a broader total.",
      "decisionImpact": "Avoids an unsupported adverse conclusion.",
      "evidence": [
        "finverbench: Section 6.4/Table 10; Section 7.2"
      ]
    },
    {
      "id": "cross_document_bridge",
      "title": "Cross-document reconciliation bridge",
      "description": "Two valid financial measures are equated without their reconciling movements.",
      "designQuestion": "Identify the valid bridge and reconcile across documents.",
      "status": "Source-motivated design hypothesis; not tested on this task. No hardness claim allowed.",
      "sourceIds": [
        "finverbench"
      ],
      "requirements": [
        "Starting and ending balances",
        "All material intervening movements",
        "Basis and sign conventions"
      ],
      "fairness": [
        "Verify the bridge is complete",
        "Do not copy oversimplified accounting identities as universal rules"
      ],
      "leakage": [
        "Hide neither movement nor governing definition",
        "Do not force a particular worksheet sequence"
      ],
      "wrongReading": "Treat a retained-earnings movement as net income despite a disclosed distribution.",
      "decisionImpact": "Changes earnings quality, available cash, or a modeled residual.",
      "evidence": [
        "finverbench: Section 3.3/Table 2; Section 6.4"
      ]
    },
    {
      "id": "rounding_calibration",
      "title": "Rounding and decision tolerance",
      "description": "Display precision is mistaken for economic inconsistency or suppresses a decisive difference.",
      "designQuestion": "Assess whether the displayed discrepancy can arise under legitimate rounding.",
      "status": "Source-motivated design hypothesis; not tested on this task. No hardness claim allowed.",
      "sourceIds": [
        "finverbench"
      ],
      "requirements": [
        "Reporting units and precision",
        "Underlying values where needed",
        "Explicit decision threshold"
      ],
      "fairness": [
        "Choose tolerances from units and decision sensitivity",
        "Check the answer remains identifiable after rendering"
      ],
      "leakage": [
        "Make mutated and control values share realistic precision",
        "Inspect PDF/XLSX display and extracted values"
      ],
      "wrongReading": "Use an unusual decimal pattern as the evidence of error.",
      "decisionImpact": "Avoids false alarms or wrong threshold calls.",
      "evidence": [
        "finverbench: Section 6.5/Table 11"
      ]
    },
    {
      "id": "table_grain",
      "title": "Row grain and subtotal boundaries",
      "description": "Headers, totals, or joint holdings are treated as ordinary independent observations.",
      "designQuestion": "Define the population before counting or aggregating.",
      "status": "Source-motivated design hypothesis; not tested on this task. No hardness claim allowed.",
      "sourceIds": [
        "finsheet"
      ],
      "requirements": [
        "Row type and fund/segment membership",
        "Subtotal labels",
        "Duplicate or joint-allocation meaning"
      ],
      "fairness": [
        "Provide legible boundaries in the actual delivered modality",
        "Allow different correct extraction methods"
      ],
      "leakage": [
        "Do not create difficulty solely by stripping indispensable formatting",
        "Test a plain-value export for answer completeness"
      ],
      "wrongReading": "Count a fund total as another investment or count a shared holding twice.",
      "decisionImpact": "Changes exposure, concentration, or allocation.",
      "evidence": [
        "finsheet: Section 4.5.1; Appendix A.7-A.8"
      ]
    },
    {
      "id": "ordered_aggregation",
      "title": "Filter, rank, then aggregate",
      "description": "Individually correct operations are executed on the wrong subset or in the wrong order.",
      "designQuestion": "Determine the requested set and then compute its statistic.",
      "status": "Source-motivated design hypothesis; not tested on this task. No hardness claim allowed.",
      "sourceIds": [
        "finsheet"
      ],
      "requirements": [
        "Eligible population",
        "Ranking variable",
        "Tie rule where relevant",
        "Aggregation definition"
      ],
      "fairness": [
        "Resolve meaningful ties visibly",
        "Supply enough rows to make every selected observation auditable"
      ],
      "leakage": [
        "Do not reveal a required implementation method in the prompt",
        "Do not add irrelevant row volume purely as a time penalty"
      ],
      "wrongReading": "Average all holdings before applying the size or eligibility filter.",
      "decisionImpact": "Changes selected investments or reported portfolio performance.",
      "evidence": [
        "finsheet: Section 5.2/Table 5; Section 6.2"
      ]
    },
    {
      "id": "contract_conditions",
      "title": "Rule activation, precedence, and exceptions",
      "description": "A familiar financial rule is applied while a qualifying condition is ignored.",
      "designQuestion": "Select the operative clause before calculating.",
      "status": "Source-motivated design hypothesis; not tested on this task. No hardness claim allowed.",
      "sourceIds": [
        "creditcardqa_paper"
      ],
      "requirements": [
        "Base rule",
        "Trigger, exception, cap, and floor",
        "Applicable dates and transaction class",
        "Any rule precedence"
      ],
      "fairness": [
        "Every branch must be specified or legitimately nonapplicable",
        "Avoid ambiguous clause precedence"
      ],
      "leakage": [
        "Do not announce the exception as a trap",
        "Retain realistic document hierarchy and discoverability"
      ],
      "wrongReading": "Charge the usual rate even though a documented exception or threshold changes it.",
      "decisionImpact": "Changes required payment, cost, drawability, or position size.",
      "evidence": [
        "creditcardqa_paper: Section 5/Table 3; Appendix B"
      ]
    },
    {
      "id": "source_sufficiency",
      "title": "Answerability and source sufficiency",
      "description": "A plausible answer is supplied despite irrelevant or unavailable evidence.",
      "designQuestion": "Decide which requested claims can actually be supported.",
      "status": "Source-motivated design hypothesis; not tested on this task. No hardness claim allowed.",
      "sourceIds": [
        "failsafeqa"
      ],
      "requirements": [
        "Question scope",
        "Available source inventory",
        "Visible source identity and coverage"
      ],
      "fairness": [
        "Use this only when acknowledging insufficiency is an acceptable deliverable",
        "Do not grade undisclosed facts as mandatory"
      ],
      "leakage": [
        "Keep reference answers inaccessible",
        "Validate degraded text still contains facts intended to remain answerable"
      ],
      "wrongReading": "Fill missing case facts from general knowledge or a similarly named issuer.",
      "decisionImpact": "Prevents unsupported approvals or recommendations.",
      "evidence": [
        "failsafeqa: Sections 2.2-2.3; Appendix C.3"
      ]
    },
    {
      "id": "counterevidence_synthesis",
      "title": "Reconcile opposing evidence",
      "description": "A persuasive narrative selects one side while ignoring a load-bearing contrary fact.",
      "designQuestion": "Explain how the evidence jointly supports a qualified decision.",
      "status": "Source-motivated design hypothesis; not tested on this task. No hardness claim allowed.",
      "sourceIds": [
        "hedgebench_paper"
      ],
      "requirements": [
        "Evidence for the thesis",
        "Relevant counterevidence",
        "Shared decision horizon and scope"
      ],
      "fairness": [
        "Grade support and reasoning, not agreement with one analyst",
        "Make the requested decision and necessary coverage public"
      ],
      "leakage": [
        "No hidden required themes unrelated to the public request",
        "Allow valid alternative supported conclusions"
      ],
      "wrongReading": "List pros and cons without resolving the decision-relevant conflict.",
      "decisionImpact": "Changes conviction, recommended action, or conditions.",
      "evidence": [
        "hedgebench_paper: Sections 4.1-4.3; Sections 5.5 and 6"
      ]
    },
    {
      "id": "citation_entailment",
      "title": "Claim-to-source attribution",
      "description": "A citation is present but does not support the associated entity, number, or causal claim.",
      "designQuestion": "Verify that each decision-bearing claim follows from the cited evidence.",
      "status": "Source-motivated design hypothesis; not tested on this task. No hardness claim allowed.",
      "sourceIds": [
        "hedgebench_paper"
      ],
      "requirements": [
        "Stable source locators",
        "Relevant supporting passages or cells",
        "Distinction between facts and analyst inference"
      ],
      "fairness": [
        "Score unsupported factual claims locally when possible",
        "Do not require exact phrasing or ornamental citations"
      ],
      "leakage": [
        "References must not expose gold answers",
        "Check citations resolve in the delivered pack"
      ],
      "wrongReading": "Cite a peer's metric to support the subject company's forecast.",
      "decisionImpact": "Exposes an apparently supported but invalid rationale.",
      "evidence": [
        "hedgebench_paper: Section 4.2"
      ]
    },
    {
      "id": "dynamic_workbook",
      "title": "Live calculation and propagation",
      "description": "A workbook matches the initial answer but is structurally wrong when an input changes.",
      "designQuestion": "Build linked calculations that preserve the specified relationships.",
      "status": "Source-motivated design hypothesis; not tested on this task. No hardness claim allowed.",
      "sourceIds": [
        "mbabench",
        "gauge"
      ],
      "requirements": [
        "Required editable inputs",
        "Output definitions",
        "Expected scenario scope",
        "Calculation assumptions"
      ],
      "fairness": [
        "Demand dynamic behavior only where the task requests a reusable model",
        "Verify formulas and recalculation in an available engine"
      ],
      "leakage": [
        "Test only disclosed input classes",
        "Keep evaluator-only scenario values separate"
      ],
      "wrongReading": "Hardcode a correct-looking output or omit a row from a calculation range.",
      "decisionImpact": "Future scenarios produce false funding or valuation results.",
      "evidence": [
        "mbabench: Section 3; Table 2",
        "gauge: Appendix H/Table 13"
      ]
    },
    {
      "id": "judgment_boundaries",
      "title": "Facts versus defensible judgment",
      "description": "A grader confuses a different defensible assumption with an error, or accepts any answer under a wide band.",
      "designQuestion": "Check unique facts exactly and assess judgment using explicit support and consistency.",
      "status": "Source-motivated design hypothesis; not tested on this task. No hardness claim allowed.",
      "sourceIds": [
        "gauge"
      ],
      "requirements": [
        "Fixed historical inputs",
        "Open assumptions",
        "Decision constraints",
        "Required assumption support"
      ],
      "fairness": [
        "Enumerate admissible interpretations instead of broad permissive grading",
        "A numeric band alone cannot validate unsupported reasoning"
      ],
      "leakage": [
        "Do not expose reference assumptions unless intended as inputs",
        "No hidden house view or privately expected recommendation"
      ],
      "wrongReading": "Match the reference price while using unsupported drivers, or reject a well-supported alternative.",
      "decisionImpact": "Changes grading validity and the investment recommendation's credibility.",
      "evidence": [
        "gauge: Sections 2.3 and 3.3; Appendix X"
      ]
    }
  ]
};
