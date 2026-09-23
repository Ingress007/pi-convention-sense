package com.acme.inventory.controller;

import org.springframework.web.bind.annotation.RestController;

@RestController
public class InventoryController {
    private final InventoryService inventoryService;

    public InventoryController(InventoryService inventoryService) {
        this.inventoryService = inventoryService;
    }
}
