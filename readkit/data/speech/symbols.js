// Symbols, Greek letters and maths operators. Greek letter names and several symbols
// come from NVIDIA NeMo-text-processing whitelist/tts.tsv and whitelist/symbol.tsv
// (Apache-2.0). See README.md.

export const GREEK = {
  α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', ϵ: 'epsilon', ζ: 'zeta', η: 'eta', θ: 'theta', ϑ: 'theta',
  ι: 'iota', κ: 'kappa', λ: 'lambda', μ: 'mu', ν: 'nu', ξ: 'xi', ο: 'omicron', π: 'pi', ρ: 'rho', σ: 'sigma', ς: 'sigma',
  τ: 'tau', υ: 'upsilon', φ: 'phi', ϕ: 'phi', χ: 'chi', ψ: 'psi', ω: 'omega',
  Α: 'alpha', Β: 'beta', Γ: 'gamma', Δ: 'delta', Ε: 'epsilon', Ζ: 'zeta', Η: 'eta', Θ: 'theta', Ι: 'iota', Κ: 'kappa',
  Λ: 'lambda', Μ: 'mu', Ν: 'nu', Ξ: 'xi', Ο: 'omicron', Π: 'pi', Ρ: 'rho', Σ: 'sigma', Τ: 'tau', Υ: 'upsilon', Φ: 'phi',
  Χ: 'chi', Ψ: 'psi', Ω: 'omega',
};

// Operators read between terms. Spaces are added around them.
export const OPERATORS = {
  '≠': 'not equal to', '≈': 'approximately', '≃': 'approximately', '≅': 'approximately equal to', '≡': 'is equivalent to',
  '≤': 'less than or equal to', '≥': 'greater than or equal to', '⩽': 'less than or equal to', '⩾': 'greater than or equal to',
  '≪': 'much less than', '≫': 'much greater than', '±': 'plus or minus', '∓': 'minus or plus', '×': 'times', '÷': 'divided by',
  '∝': 'is proportional to', '∈': 'in', '∉': 'not in', '⊂': 'a subset of', '⊆': 'a subset of', '∪': 'union',
  '∩': 'intersection', '∧': 'and', '∨': 'or', '¬': 'not', '⇒': 'implies', '⟹': 'implies', '⇔': 'if and only if',
  '⟺': 'if and only if', '→': 'to', '⟶': 'to', '∀': 'for all', '∃': 'there exists', '∞': 'infinity', '∑': 'the sum of',
  '∏': 'the product of', '∫': 'the integral of', '∂': 'partial', '∇': 'nabla', '√': 'the square root of',
  '∛': 'the cube root of', '∜': 'the fourth root of', '∠': 'angle', '⊥': 'perpendicular to', '∥': 'parallel to',
  '‰': 'per mille', '∴': 'therefore', '∵': 'because',
};

// Read wherever they appear outside other rules.
export const SYMBOLS = {
  '&': 'and', '§': 'section', '§§': 'sections', '¶': 'paragraph', '°': 'degrees', '%': 'percent', '@': 'at',
};
