/**
 * De-vig (remove vig/juice) from American odds and convert to implied probabilities
 * 
 * @param {Array} outcomes - Array of outcome objects with 'name' and 'price' (American odds)
 * @returns {Array} Array of outcome objects with added 'impliedProb' and 'deVigProb' (as percentages)
 */
function deVigOdds(outcomes) {
  // Convert American odds to implied probabilities
  const outcomesWithProb = outcomes.map(outcome => {
    const americanOdds = outcome.price;
    let impliedProb;
    
    if (americanOdds > 0) {
      // Positive odds: +150 -> 100/(150+100) = 0.4 = 40%
      impliedProb = 100 / (americanOdds + 100);
    } else {
      // Negative odds: -150 -> 150/(150+100) = 0.6 = 60%
      impliedProb = Math.abs(americanOdds) / (Math.abs(americanOdds) + 100);
    }
    
    return {
      ...outcome,
      impliedProb: impliedProb * 100 // Store as percentage
    };
  });
  
  // Calculate total implied probability (this includes the vig)
  const totalImpliedProb = outcomesWithProb.reduce((sum, outcome) => sum + outcome.impliedProb, 0);
  
  // Normalize probabilities to remove vig (divide by total to make them sum to 100%)
  const deViggedOutcomes = outcomesWithProb.map(outcome => ({
    ...outcome,
    deVigProb: (outcome.impliedProb / totalImpliedProb) * 100,
    vig: totalImpliedProb - 100 // The vig is the excess over 100%
  }));
  
  return deViggedOutcomes;
}

/**
 * Format odds information for display
 * 
 * @param {Array} outcomes - Array of outcome objects (can be raw or de-vigged)
 * @param {boolean} includeDeVig - Whether to include de-vigged probabilities
 * @returns {string} Formatted string
 */
function formatOdds(outcomes, includeDeVig = true) {
  let output = '';
  
  if (includeDeVig && outcomes[0]?.deVigProb !== undefined) {
    // De-vigged outcomes
    outcomes.forEach(outcome => {
      output += `  ${outcome.name}:\n`;
      output += `    American Odds: ${outcome.price > 0 ? '+' : ''}${outcome.price}\n`;
      output += `    Implied Probability (with vig): ${outcome.impliedProb.toFixed(2)}%\n`;
      output += `    True Probability (de-vigged): ${outcome.deVigProb.toFixed(2)}%\n`;
      if (outcome.vig !== undefined) {
        output += `    Vig: ${outcome.vig.toFixed(2)}%\n`;
      }
      output += '\n';
    });
  } else {
    // Raw outcomes
    outcomes.forEach(outcome => {
      output += `  ${outcome.name}: ${outcome.price > 0 ? '+' : ''}${outcome.price}\n`;
    });
  }
  
  return output;
}

module.exports = {
  deVigOdds,
  formatOdds
};

