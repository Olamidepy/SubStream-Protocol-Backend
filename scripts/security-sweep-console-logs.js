#!/usr/bin/env node

/**
 * Security Sweep Script - Console.log User Data Detection
 * 
 * This script scans the codebase for console.log statements that may contain
 * user-sensitive data such as emails, passwords, tokens, API keys, or PII.
 * 
 * Usage: node scripts/security-sweep-console-logs.js
 * 
 * Exit codes:
 * 0 - No issues found
 * 1 - Issues found
 * 2 - Error running script
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Patterns that indicate user data in console.log
const SENSITIVE_PATTERNS = [
  {
    name: 'Email addresses',
    pattern: /console\.log\s*\([^)]*\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/gi,
    severity: 'HIGH'
  },
  {
    name: 'Password references',
    pattern: /console\.log\s*\([^)]*\b(password|passwd|pwd)\b/gi,
    severity: 'CRITICAL'
  },
  {
    name: 'Token references',
    pattern: /console\.log\s*\([^)]*\b(token|jwt|bearer)\b/gi,
    severity: 'HIGH'
  },
  {
    name: 'API key references',
    pattern: /console\.log\s*\([^)]*\b(api[_-]?key|apikey|secret)\b/gi,
    severity: 'CRITICAL'
  },
  {
    name: 'Credit card numbers',
    pattern: /console\.log\s*\([^)]*\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/gi,
    severity: 'CRITICAL'
  },
  {
    name: 'SSN/SIN numbers',
    pattern: /console\.log\s*\([^)]*\b\d{3}[-]?\d{2}[-]?\d{4}\b/gi,
    severity: 'CRITICAL'
  },
  {
    name: 'User address references',
    pattern: /console\.log\s*\([^)]*\b(userAddress|wallet_address|walletAddress)\b/gi,
    severity: 'MEDIUM'
  },
  {
    name: 'User ID references',
    pattern: /console\.log\s*\([^)]*\b(userId|user_id|userid)\b/gi,
    severity: 'MEDIUM'
  },
  {
    name: 'Personal name references',
    pattern: /console\.log\s*\([^)]*\b(firstName|lastName|fullName|full_name)\b/gi,
    severity: 'MEDIUM'
  },
  {
    name: 'Phone numbers',
    pattern: /console\.log\s*\([^)]*\b\+?[\d\s-]{10,}\b/gi,
    severity: 'HIGH'
  }
];

// Direct patterns - console.log with actual user data variables
const DIRECT_PATTERNS = [
  {
    name: 'Direct user.email logging',
    pattern: /console\.log\s*\([^)]*user\.email/gi,
    severity: 'CRITICAL'
  },
  {
    name: 'Direct user.password logging',
    pattern: /console\.log\s*\([^)]*user\.password/gi,
    severity: 'CRITICAL'
  },
  {
    name: 'Direct req.user logging',
    pattern: /console\.log\s*\([^)]*req\.user/gi,
    severity: 'HIGH'
  },
  {
    name: 'Direct req.body logging',
    pattern: /console\.log\s*\([^)]*req\.body/gi,
    severity: 'HIGH'
  },
  {
    name: 'Direct req.headers logging',
    pattern: /console\.log\s*\([^)]*req\.headers/gi,
    severity: 'HIGH'
  }
];

// Files to exclude from scanning
const EXCLUDE_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt'
];

const EXCLUDE_FILES = [
  '*.test.js',
  '*.test.ts',
  '*.spec.js',
  '*.spec.ts',
  '*.min.js',
  'package-lock.json',
  'yarn.lock'
];

// File extensions to scan
const SCAN_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'];

let totalFilesScanned = 0;
let totalIssuesFound = 0;
const findings = [];

/**
 * Check if a path should be excluded
 */
function shouldExcludePath(filePath) {
  const relativePath = path.relative(process.cwd(), filePath);
  
  // Check exclude directories
  for (const dir of EXCLUDE_DIRS) {
    if (relativePath.includes(path.sep + dir) || relativePath.startsWith(dir + path.sep)) {
      return true;
    }
  }
  
  // Check exclude files
  for (const pattern of EXCLUDE_FILES) {
    const regex = new RegExp(pattern.replace('*', '.*'));
    if (regex.test(path.basename(filePath))) {
      return true;
    }
  }
  
  return false;
}

/**
 * Check if file has scannable extension
 */
function isScannableFile(filePath) {
  const ext = path.extname(filePath);
  return SCAN_EXTENSIONS.includes(ext);
}

/**
 * Scan a single file for sensitive console.log patterns
 */
function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const fileFindings = [];
  
  lines.forEach((line, lineNum) => {
    // Check sensitive patterns
    for (const pattern of SENSITIVE_PATTERNS) {
      const matches = line.match(pattern.pattern);
      if (matches) {
        fileFindings.push({
          line: lineNum + 1,
          pattern: pattern.name,
          severity: pattern.severity,
          match: matches[0],
          code: line.trim()
        });
      }
    }
    
    // Check direct patterns
    for (const pattern of DIRECT_PATTERNS) {
      const matches = line.match(pattern.pattern);
      if (matches) {
        fileFindings.push({
          line: lineNum + 1,
          pattern: pattern.name,
          severity: pattern.severity,
          match: matches[0],
          code: line.trim()
        });
      }
    }
  });
  
  if (fileFindings.length > 0) {
    findings.push({
      file: path.relative(process.cwd(), filePath),
      issues: fileFindings
    });
  }
  
  return fileFindings.length;
}

/**
 * Recursively scan directory
 */
function scanDirectory(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (shouldExcludePath(fullPath)) {
      continue;
    }
    
    if (entry.isDirectory()) {
      scanDirectory(fullPath);
    } else if (entry.isFile() && isScannableFile(fullPath)) {
      totalFilesScanned++;
      const issues = scanFile(fullPath);
      totalIssuesFound += issues;
    }
  }
}

/**
 * Print findings grouped by severity
 */
function printFindings() {
  const critical = [];
  const high = [];
  const medium = [];
  const low = [];
  
  findings.forEach(file => {
    file.issues.forEach(issue => {
      const finding = {
        file: file.file,
        line: issue.line,
        pattern: issue.pattern,
        code: issue.code
      };
      
      switch (issue.severity) {
        case 'CRITICAL':
          critical.push(finding);
          break;
        case 'HIGH':
          high.push(finding);
          break;
        case 'MEDIUM':
          medium.push(finding);
          break;
        default:
          low.push(finding);
      }
    });
  });
  
  console.log('\n=== SECURITY SWEEP RESULTS ===\n');
  
  if (critical.length > 0) {
    console.log('🔴 CRITICAL ISSUES:');
    console.log('-------------------');
    critical.forEach(f => {
      console.log(`  ${f.file}:${f.line}`);
      console.log(`    Pattern: ${f.pattern}`);
      console.log(`    Code: ${f.code.substring(0, 100)}...`);
      console.log('');
    });
  }
  
  if (high.length > 0) {
    console.log('🟠 HIGH SEVERITY:');
    console.log('-----------------');
    high.forEach(f => {
      console.log(`  ${f.file}:${f.line}`);
      console.log(`    Pattern: ${f.pattern}`);
      console.log(`    Code: ${f.code.substring(0, 100)}...`);
      console.log('');
    });
  }
  
  if (medium.length > 0) {
    console.log('🟡 MEDIUM SEVERITY:');
    console.log('-------------------');
    medium.forEach(f => {
      console.log(`  ${f.file}:${f.line}`);
      console.log(`    Pattern: ${f.pattern}`);
      console.log(`    Code: ${f.code.substring(0, 100)}...`);
      console.log('');
    });
  }
  
  if (low.length > 0) {
    console.log('🟢 LOW SEVERITY:');
    console.log('----------------');
    low.forEach(f => {
      console.log(`  ${f.file}:${f.line}`);
      console.log(`    Pattern: ${f.pattern}`);
      console.log(`    Code: ${f.code.substring(0, 100)}...`);
      console.log('');
    });
  }
  
  console.log('\n=== SUMMARY ===');
  console.log(`Files scanned: ${totalFilesScanned}`);
  console.log(`Total issues found: ${totalIssuesFound}`);
  console.log(`Critical: ${critical.length}`);
  console.log(`High: ${high.length}`);
  console.log(`Medium: ${medium.length}`);
  console.log(`Low: ${low.length}`);
}

/**
 * Generate report file
 */
function generateReport() {
  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      filesScanned: totalFilesScanned,
      totalIssues: totalIssuesFound,
      critical: findings.filter(f => f.issues.some(i => i.severity === 'CRITICAL')).length,
      high: findings.filter(f => f.issues.some(i => i.severity === 'HIGH')).length,
      medium: findings.filter(f => f.issues.some(i => i.severity === 'MEDIUM')).length,
      low: findings.filter(f => f.issues.some(i => i.severity === 'LOW')).length
    },
    findings: findings
  };
  
  const reportPath = path.join(process.cwd(), 'security-sweep-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nDetailed report saved to: ${reportPath}`);
}

/**
 * Main execution
 */
function main() {
  console.log('🔍 Starting Security Sweep for console.log with user data...\n');
  
  try {
    scanDirectory(process.cwd());
    printFindings();
    generateReport();
    
    if (totalIssuesFound > 0) {
      console.log('\n⚠️  ISSUES FOUND - Please review and fix before deployment');
      process.exit(1);
    } else {
      console.log('\n✅ No issues found - Codebase is clean');
      process.exit(0);
    }
  } catch (error) {
    console.error('❌ Error running security sweep:', error.message);
    process.exit(2);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

module.exports = { scanFile, scanDirectory, SENSITIVE_PATTERNS, DIRECT_PATTERNS };
