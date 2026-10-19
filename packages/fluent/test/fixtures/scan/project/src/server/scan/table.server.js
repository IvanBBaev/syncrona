;(function check(current) {
    if (current.size_bytes > 10485760) {
        finding.increment()
    }
})(current)
