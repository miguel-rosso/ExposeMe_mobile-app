# Sample lines for test-scripts.test.sh's checker: those marked FLAG pipe into an early-exiting grep
sed "s/x//" f | grep -qxF -- "$1"   # FLAG
cmd \
  | grep -q "a" \
  && ok   # (the line above: FLAG)
cat f | grep --quiet a   # FLAG
grep -c a f | grep -v b
# x | grep -q y
grep -q a <<<"$(sed x f)"
grep -q a "$TMP/lines"
[ -s f ] || grep -q a g
