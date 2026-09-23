package com.acme.order.service.impl;

import com.acme.order.mapper.LegacyMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

@Slf4j
@Service
public class LegacyServiceImpl implements LegacyService {
    @Autowired
    private LegacyMapper legacyMapper;

    public LegacyResponse load(String id) {
        log.info("loading legacy " + id);
        return legacyMapper.toResponse(id);
    }
}
